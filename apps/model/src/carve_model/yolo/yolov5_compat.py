"""Support for classic YOLOv5 checkpoints.

Two different things are called "YOLOv5":

* the anchor-free ``yolov5su.pt`` weights the ultralytics package ships,
  which ``ultralytics.YOLO()`` loads natively; and
* checkpoints trained with the original ``ultralytics/yolov5`` repo,
  which pickle their layers from that repo's TOP-LEVEL ``models`` and
  ``utils`` packages.

Only the second needs this module. ``ultralytics.nn.tasks.torch_safe_load``
remaps *old ultralytics* module paths (``ultralytics.yolo.*``) but knows
nothing about the yolov5 repo, so unpickling one of those files raises
``ModuleNotFoundError: No module named 'models'``. In Carve that surfaced
as a weight that uploaded happily, reported "0 classes" because inspection
failed, and then 500'd on every predict.

The repo is vendored into the image (see the model Dockerfile) and put on
``sys.path`` **only for the duration of a load**. It is deliberately not on
``PYTHONPATH``: the repo's top-level ``utils`` package would shadow any
other ``utils`` import in the process.

Inference deliberately does NOT use the repo's ``AutoShape`` /
``non_max_suppression`` helpers. Those pull in a large part of the repo
(plots, dataloaders, pandas/seaborn) and their signatures have shifted
across versions. The forward pass of a YOLOv5 detection model is stable
and small, so letterboxing and NMS are done here against torch and
torchvision directly. That keeps the dependency surface to "can the
pickle find its classes".
"""

from __future__ import annotations

import io
import logging
import os
import sys
import threading
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

#: Where the vendored repo lives. Overridable for local dev.
YOLOV5_DIR = os.environ.get("CARVE_YOLOV5_DIR", "/opt/yolov5")

#: Module prefixes that identify a checkpoint as coming from the yolov5
#: repo rather than the ultralytics package.
_V5_MARKERS = (b"models.yolo", b"models.common", b"models.experimental")

#: Serialises sys.path mutation. Loads already happen under the registry
#: lock, but inspection runs on the request thread.
_PATH_LOCK = threading.Lock()


def is_yolov5_checkpoint(path: Path | str) -> bool:
    """True when ``path`` is a classic yolov5-repo checkpoint.

    Reads the pickle's raw bytes and looks for the repo's module names.
    Deliberately does not unpickle: this runs before we have decided the
    file is loadable at all, and the whole question is *which* loader is
    safe to hand it to.

    Returns False for anything unreadable — the caller then takes the
    ultralytics path, whose error messages are the ones users already
    know.
    """
    try:
        with zipfile.ZipFile(str(path)) as zf:
            pickles = [n for n in zf.namelist() if n.endswith("data.pkl")]
            if not pickles:
                return False
            raw = zf.read(pickles[0])
    except Exception:  # noqa: BLE001 — not a zip, truncated, unreadable
        return False
    return any(marker in raw for marker in _V5_MARKERS)


@contextmanager
def yolov5_importable():
    """Make the vendored repo's ``models`` / ``utils`` importable.

    Scoped as tightly as possible: the path goes on at the front (the
    pickle must find the repo's ``utils``, not some other one), and comes
    off again immediately. Modules already imported stay in
    ``sys.modules`` — the unpickled objects hold references to those
    classes, so evicting them would break a model that is still loaded.
    """
    d = YOLOV5_DIR
    if not os.path.isdir(d):
        raise RuntimeError(
            f"yolov5 support is not installed: {d} does not exist. "
            "Rebuild the model image (apps/model/Dockerfile clones it)."
        )
    with _PATH_LOCK:
        sys.path.insert(0, d)
        try:
            yield
        finally:
            try:
                sys.path.remove(d)
            except ValueError:  # pragma: no cover — someone else removed it
                pass


def torch_load_v5(path: Path | str) -> Any:
    """``torch.load`` a classic yolov5 checkpoint.

    ``weights_only=False`` for the same reason the ultralytics path uses
    it: these checkpoints embed model objects, and the file has already
    passed the api's auth + extension + size checks.
    """
    import torch  # noqa: PLC0415 — heavy, imported lazily

    with yolov5_importable():
        return torch.load(str(path), map_location="cpu", weights_only=False)


# ---------------------------------------------------------------------------
# Ultralytics-shaped adapter
# ---------------------------------------------------------------------------


class _Boxes:
    """The subset of ultralytics' ``Boxes`` that ``predict_image`` reads."""

    def __init__(self, xyxy, conf, cls) -> None:
        self.xyxy = xyxy
        self.conf = conf
        self.cls = cls


class _Results:
    """The subset of ultralytics' ``Results`` that ``predict_image`` reads.

    ``masks`` is always None: the yolov5 repo's segmentation variant
    stores masks differently and Carve only ever ran v5 detection models.
    A segmentation v5 checkpoint still yields boxes, which is a better
    outcome than refusing to load it.
    """

    def __init__(self, boxes: _Boxes, names: dict[int, str]) -> None:
        self.boxes = boxes
        self.masks = None
        self.names = names


class Yolov5Model:
    """Wraps a yolov5 ``DetectionModel`` behind ultralytics' predict API.

    ``predict_image`` is duck-typed against ultralytics: it calls
    ``model.predict(img, conf=, iou=, half=, device=, verbose=)`` and
    reads ``[0].boxes.{xyxy,conf,cls}`` plus ``.names``. Matching that
    shape here means the rest of the pipeline — batching, class mapping,
    hierarchy resolution, the API — needs no knowledge of model vintage.
    """

    def __init__(self, model: Any, names: dict[int, str], stride: int = 32) -> None:
        self.model = model
        self.names = names
        self.stride = max(int(stride), 32)
        self._device = "cpu"
        self._half = False
        self.task = "detect"
        # One instance is shared by every request for this weight (the
        # registry is an LRU cache) and the model service runs predicts in
        # a threadpool. ``predict`` mutates shared state — it moves the
        # module between devices and flips its dtype — so without this the
        # calls race: one thread converts to float while another is mid
        # forward pass in half, which surfaces as "Expected weight to have
        # type Float but got Half" and, when the device move is what gets
        # interleaved, a segfault. A batch auto-annotate fires exactly this
        # pattern. Inference on a single model does not parallelise usefully
        # anyway (the GPU serialises it), so the lock costs no throughput.
        self._lock = threading.Lock()

    # -- device / precision ------------------------------------------------

    def to(self, device: str) -> "Yolov5Model":
        import torch  # noqa: PLC0415

        self.model.to(torch.device(device))
        self._device = device
        return self

    def _apply_precision(self, half: bool) -> None:
        """FP16 only on CUDA; elsewhere it is either unsupported or slower."""
        want = bool(half) and self._device.startswith("cuda")
        if want == self._half:
            return
        self.model.half() if want else self.model.float()
        self._half = want

    # -- inference ---------------------------------------------------------

    def predict(
        self,
        img: np.ndarray,
        *,
        conf: float = 0.25,
        iou: float = 0.7,
        half: bool = False,
        device: str | None = None,
        verbose: bool = False,  # noqa: ARG002 — accepted for API parity
        **_: Any,
    ) -> list[_Results]:
        """Run detection on one image.

        ``img`` arrives BGR because that is what ultralytics wants (see
        ``predict_image``); YOLOv5 wants RGB, so it is flipped back here
        rather than changing the shared caller.
        """
        import torch  # noqa: PLC0415

        rgb = np.ascontiguousarray(img[:, :, ::-1])
        h0, w0 = rgb.shape[:2]
        letterboxed, ratio, (dw, dh) = _letterbox(rgb, stride=self.stride)

        # Everything that touches shared module state — the device move,
        # the dtype flip and the forward pass itself — happens under one
        # lock, so a concurrent call cannot observe the module halfway
        # through a conversion.
        with self._lock:
            if device and device != self._device:
                self.to(device)
            self._apply_precision(half)

            x = torch.from_numpy(letterboxed.transpose(2, 0, 1)).float()
            x = x.unsqueeze(0).to(self._device)
            # Take the dtype from the module rather than from ``_half``:
            # the flag is our own bookkeeping, while this is the ground
            # truth the conv layers will actually check.
            try:
                param_dtype = next(self.model.parameters()).dtype
            except StopIteration:  # pragma: no cover — models have params
                param_dtype = torch.float32
            x = x.to(param_dtype)
            x /= 255.0

            with torch.no_grad():
                out = self.model(x)
            pred = out[0] if isinstance(out, (list, tuple)) else out
            pred = pred.detach().float()

        det = _nms(pred, conf_thres=conf, iou_thres=iou)
        if det.numel():
            # Undo letterbox padding + scale back to the source image.
            det[:, [0, 2]] -= dw
            det[:, [1, 3]] -= dh
            det[:, :4] /= ratio
            det[:, [0, 2]] = det[:, [0, 2]].clamp(0, w0)
            det[:, [1, 3]] = det[:, [1, 3]].clamp(0, h0)

        boxes = _Boxes(
            xyxy=det[:, :4].cpu(),
            conf=det[:, 4].cpu(),
            cls=det[:, 5].cpu(),
        )
        return [_Results(boxes, self.names)]


# ---------------------------------------------------------------------------
# pre/post-processing
# ---------------------------------------------------------------------------


def _letterbox(
    img: np.ndarray, size: int = 640, stride: int = 32, color: int = 114
) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Resize preserving aspect ratio, pad to a stride multiple.

    Returns the padded image, the scale factor, and the (left, top)
    padding, which ``predict`` needs to map boxes back to source pixels.
    Scale-up is allowed: YOLOv5's own detect.py does the same, and
    refusing it would silently degrade small images.
    """
    h, w = img.shape[:2]
    r = min(size / h, size / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    if (nh, nw) != (h, w):
        import cv2  # noqa: PLC0415

        # INTER_LINEAR unconditionally, matching yolov5's own letterbox
        # (utils/augmentations.py). INTER_AREA is the textbook choice for
        # downscaling and was used here at first, but the model was
        # TRAINED on INTER_LINEAR-resized crops: feeding it a differently
        # resampled image shifts the input distribution enough to move
        # confidences substantially — one real frame scored 0.164 with
        # INTER_AREA against 0.451 with INTER_LINEAR, which flipped
        # detections either side of the threshold. Boxes barely move, so
        # this fails quietly rather than obviously. Match the trainer.
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)

    # Pad to the next stride multiple on each side, centred.
    ph = (int(np.ceil(nh / stride)) * stride) - nh
    pw = (int(np.ceil(nw / stride)) * stride) - nw
    top, left = ph // 2, pw // 2
    out = np.full((nh + ph, nw + pw, 3), color, dtype=img.dtype)
    out[top : top + nh, left : left + nw] = img
    return out, r, (float(left), float(top))


def _nms(pred, *, conf_thres: float, iou_thres: float, max_det: int = 300):
    """Confidence filter + class-aware NMS on YOLOv5 raw output.

    ``pred`` is ``[batch, anchors, 5 + nc]`` with ``xywh`` centre boxes,
    an objectness score, and per-class scores. Score is objectness ×
    class probability, matching the repo. Only the first batch item is
    used — Carve predicts one image at a time.
    """
    import torch  # noqa: PLC0415
    from torchvision.ops import batched_nms  # noqa: PLC0415

    p = pred[0]
    if p.ndim != 2 or p.shape[1] < 6:
        return torch.zeros((0, 6))

    obj = p[:, 4]
    keep = obj > conf_thres
    p = p[keep]
    if not p.shape[0]:
        return torch.zeros((0, 6))

    scores_all = p[:, 5:] * p[:, 4:5]
    scores, classes = scores_all.max(1)
    keep = scores > conf_thres
    p, scores, classes = p[keep], scores[keep], classes[keep]
    if not p.shape[0]:
        return torch.zeros((0, 6))

    # xywh (centre) -> xyxy
    xy, wh = p[:, :2], p[:, 2:4]
    boxes = torch.cat((xy - wh / 2, xy + wh / 2), dim=1)

    idx = batched_nms(boxes, scores, classes, iou_thres)[:max_det]
    return torch.cat(
        (boxes[idx], scores[idx, None], classes[idx, None].float()), dim=1
    )


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------


def extract_names(ckpt: Any) -> dict[int, str]:
    """Pull the class table out of a v5 checkpoint.

    v5 stores ``names`` as a list (index-ordered) on older checkpoints and
    a dict on newer ones; both appear in the wild.
    """
    # Prefer the EMA for the same reason ``load_model`` does: an
    # interrupted run leaves ``model`` empty and the real weights (and
    # names) under ``ema``.
    model = (ckpt.get("ema") or ckpt.get("model")) if isinstance(ckpt, dict) else ckpt
    names = getattr(model, "names", None)
    if names is None and isinstance(ckpt, dict):
        names = ckpt.get("names")
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, (list, tuple)):
        return {i: str(v) for i, v in enumerate(names)}
    return {}


def load_model(path: Path | str) -> Yolov5Model:
    """Load a classic yolov5 checkpoint into an ultralytics-shaped wrapper."""
    ckpt = torch_load_v5(path)
    model = ckpt.get("ema") or ckpt.get("model") if isinstance(ckpt, dict) else ckpt
    if model is None:
        raise ValueError("yolov5 checkpoint has no 'model' or 'ema' entry")

    model = model.float().eval()
    # Detect layers keep training-time state that breaks a plain forward.
    for m in model.modules():
        if m.__class__.__name__ == "Detect":
            m.inplace = True
            if not hasattr(m, "dynamic"):
                m.dynamic = False
        # Older checkpoints predate nn.Upsample.recompute_scale_factor
        # being removed from torch; leaving it set raises on forward.
        if isinstance(m, __import__("torch").nn.Upsample) and not hasattr(
            m, "recompute_scale_factor"
        ):
            m.recompute_scale_factor = None  # type: ignore[attr-defined]

    stride = 32
    s = getattr(model, "stride", None)
    if s is not None:
        try:
            stride = int(s.max())
        except Exception:  # noqa: BLE001
            pass

    names = extract_names(ckpt)
    log.info(
        "yolov5: loaded %s (%d classes, stride %d)", path, len(names), stride
    )
    return Yolov5Model(model, names, stride=stride)
