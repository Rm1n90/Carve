"""Run a YOLOE model and shape the output.

Three entry points, one per prompting mode. All return the same
``{detections: [...], polygons: [...]}`` contract the YOLO predict
path produces, so the API service's class-mapping + persistence
layer is reused without changes.

The functions accept any ``model`` exposing the relevant Ultralytics
methods (``set_classes``, ``predict``). Production callers pass a
``YOLOE`` instance; tests pass stubs.
"""

from __future__ import annotations

import io
import logging
from typing import Any, Sequence

import numpy as np
from PIL import Image

log = logging.getLogger(__name__)


def _bytes_to_rgb(image_bytes: bytes) -> np.ndarray:
    """Decode JPEG/PNG bytes into an HxWx3 uint8 RGB array."""
    return np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))


def _to_numpy(arr: Any) -> np.ndarray:
    if hasattr(arr, "cpu"):
        return arr.cpu().numpy()
    return np.asarray(arr)


def _name_for(names: Any, idx: int) -> str:
    """Look up a class name from Ultralytics' ``names`` (dict or list)."""
    if isinstance(names, dict):
        return str(names.get(idx, str(idx)))
    if isinstance(names, (list, tuple)) and 0 <= idx < len(names):
        return str(names[idx])
    return str(idx)


def _shape_results(results: Any) -> dict:
    """Convert an Ultralytics ``Results`` to ``{detections, polygons}``.

    Mirrors ``carve_model.yolo.predict.predict_image`` so downstream
    persistence and class-mapping logic is identical.
    """
    detections: list[dict] = []
    polygons: list[dict] = []

    boxes = getattr(results, "boxes", None)
    masks = getattr(results, "masks", None)
    names = getattr(results, "names", {}) or {}

    if boxes is None:
        return {"detections": detections, "polygons": polygons}

    xyxy = _to_numpy(boxes.xyxy)
    confs = _to_numpy(boxes.conf)
    cls = _to_numpy(boxes.cls).astype(int)

    for (x1, y1, x2, y2), c, k in zip(xyxy, confs, cls, strict=True):
        detections.append({
            "class_name": _name_for(names, int(k)),
            "confidence": float(c),
            "bbox": {
                "x": float(x1),
                "y": float(y1),
                "w": float(x2 - x1),
                "h": float(y2 - y1),
            },
        })

    if masks is not None:
        mask_xy = getattr(masks, "xy", None)
        if mask_xy is not None:
            for poly, k, c in zip(mask_xy, cls, confs, strict=True):
                polygons.append({
                    "class_name": _name_for(names, int(k)),
                    "confidence": float(c),
                    "points": [[float(p[0]), float(p[1])] for p in poly],
                })

    return {"detections": detections, "polygons": polygons}


def predict_text(
    model: Any,
    image_bytes: bytes,
    classes: Sequence[str],
    *,
    conf: float = 0.25,
    iou: float = 0.7,
) -> dict:
    """Run YOLOE in text-prompt mode.

    ``classes`` is the user-supplied vocabulary (e.g. ``["person", "bus"]``).
    Empty / whitespace-only entries are dropped before ``set_classes``.
    """
    cleaned = [c.strip() for c in classes if isinstance(c, str) and c.strip()]
    if not cleaned:
        raise ValueError("classes_empty")
    img = _bytes_to_rgb(image_bytes)
    # v3.23.3 — defensive: Ultralytics' YOLOE.set_classes does
    # ``sorted(list(self.model.names.values()))`` to compare current
    # vs requested vocab. After a previous set_classes that very same
    # ``self.model.names`` may have been overwritten as a list, which
    # makes ``.values()`` raise AttributeError on the next call. Coerce
    # to a dict here so the second-and-later calls always succeed.
    inner = getattr(model, "model", None)
    inner_names = getattr(inner, "names", None) if inner is not None else None
    if inner is not None and isinstance(inner_names, (list, tuple)):
        inner.names = {i: str(n) for i, n in enumerate(inner_names)}
    model.set_classes(cleaned)
    results = model.predict(img, conf=conf, iou=iou, verbose=False)[0]
    return _shape_results(results)


class _NamedResults:
    """Adapter that overrides ``names`` on an Ultralytics Results.

    Used in visual-prompt mode where YOLOE emits integer class indices
    (0, 1, ...) and we want to inject the user-supplied label-per-index
    mapping so the downstream shaping returns human-readable names.
    """

    def __init__(self, inner: Any, names: dict[int, str]) -> None:
        self._inner = inner
        self.names = names

    def __getattr__(self, attr: str) -> Any:
        return getattr(self._inner, attr)


def predict_visual(
    model: Any,
    target_bytes: bytes,
    refer_bytes: bytes,
    bboxes: Sequence[Sequence[float]],
    cls_indices: Sequence[int],
    class_names: Sequence[str],
    *,
    conf: float = 0.25,
    iou: float = 0.7,
) -> dict:
    """Run YOLOE in visual-prompt mode.

    ``refer_bytes`` is the reference image; ``bboxes`` are xyxy pixel
    coords inside the reference. ``cls_indices`` matches Ultralytics'
    ``cls`` array shape (parallel to ``bboxes``). ``class_names`` is
    the label-per-cls-index mapping the API supplies — we attach those
    names back onto the Ultralytics ``Results`` before shaping so the
    downstream persistence layer sees human-readable names instead of
    the integer indices YOLOE emits internally.
    """
    if not bboxes:
        raise ValueError("bboxes_empty")
    if len(bboxes) != len(cls_indices):
        raise ValueError("bboxes_cls_length_mismatch")
    target = _bytes_to_rgb(target_bytes)
    visual_prompts = {
        "bboxes": np.asarray(bboxes, dtype=float),
        "cls": np.asarray(cls_indices, dtype=int),
    }
    # Lazy-import so the module loads on dev boxes without ultralytics.
    from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor  # type: ignore[import-not-found]

    # v3.23 fix — the Ultralytics example for "use the same image as
    # reference" omits ``refer_image`` entirely. Passing the same array
    # for both target and reference is functionally equivalent for
    # current Ultralytics, but the canonical API is to omit the kwarg
    # when there's no separate reference. Identity check first (the
    # api wraps both calls around the same in-memory bytes); fall back
    # to value equality.
    same_image = (refer_bytes is target_bytes) or (refer_bytes == target_bytes)
    kwargs: dict[str, Any] = {
        "visual_prompts": visual_prompts,
        "predictor": YOLOEVPSegPredictor,
        "conf": conf,
        "iou": iou,
        "verbose": False,
    }
    if not same_image:
        kwargs["refer_image"] = _bytes_to_rgb(refer_bytes)
    results = model.predict(target, **kwargs)[0]
    if class_names:
        names_map = {i: str(n) for i, n in enumerate(class_names)}
        try:
            results.names = names_map
        except (AttributeError, TypeError):
            results = _NamedResults(results, names_map)
    return _shape_results(results)


def predict_prompt_free(
    model: Any,
    image_bytes: bytes,
    *,
    conf: float = 0.25,
    iou: float = 0.7,
    max_detections: int | None = None,
) -> dict:
    """Run YOLOE-PF over the image with its 4585-class RAM++ vocabulary.

    ``max_detections`` caps the per-image output via Ultralytics'
    ``max_det`` arg. ``None`` keeps the default (300).
    """
    img = _bytes_to_rgb(image_bytes)
    kwargs: dict[str, Any] = {"conf": conf, "iou": iou, "verbose": False}
    if max_detections is not None and max_detections > 0:
        kwargs["max_det"] = int(max_detections)
    results = model.predict(img, **kwargs)[0]
    return _shape_results(results)
