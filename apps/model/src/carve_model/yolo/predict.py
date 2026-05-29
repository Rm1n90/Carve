"""Run a YOLO model over a single image and shape the output.

The function accepts any model object implementing ``predict(np.ndarray, **kwargs)``
returning a ``Results``-like object with ``boxes``, optional ``masks``, and
``names``. Production code passes an Ultralytics ``YOLO`` instance.
"""

import io
import logging
from typing import Any

import numpy as np
from PIL import Image

log = logging.getLogger(__name__)


def predict_image(
    model: Any,
    image_bytes: bytes,
    *,
    conf: float = 0.25,
    iou: float = 0.7,
    half: bool = True,
    device: str | None = None,
) -> dict:
    """Run YOLO predict on a single image.

    v3.7.5 — ``half=True`` enables FP16 inference on CUDA (typically ~2x
    faster). Ultralytics auto-falls-back to FP32 on CPU.
    v3.25 — ``device`` is forwarded to ``model.predict`` when set so the
    central device manager can route inference. ``None`` keeps Ultralytics'
    default (the model's loaded device). FP16 is silently turned off when
    running on CPU or MPS — half precision only matters on CUDA and the
    Ultralytics warning would otherwise leak through to the user.
    """
    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    kwargs: dict[str, Any] = {"conf": conf, "iou": iou, "verbose": False}
    if device and not device.startswith("cuda"):
        kwargs["half"] = False
    else:
        kwargs["half"] = half
    if device:
        kwargs["device"] = device
    # Ultralytics treats ndarray inputs as BGR — BasePredictor.preprocess runs
    # `im[..., ::-1]` (BGR->RGB) on every ndarray. Hand it BGR so the model
    # perceives the true RGB image; passing RGB silently swaps R/B and corrupts
    # detections (wrong + missing classes). File/PIL inputs avoid this because
    # Ultralytics' loader pre-swaps RGB->BGR for them.
    img_bgr = np.ascontiguousarray(img[:, :, ::-1])
    results = model.predict(img_bgr, **kwargs)[0]

    detections: list[dict] = []
    polygons: list[dict] = []

    boxes = getattr(results, "boxes", None)
    masks = getattr(results, "masks", None)
    names = getattr(results, "names", {})

    if boxes is not None:
        xyxy = _to_numpy(boxes.xyxy)
        confs = _to_numpy(boxes.conf)
        cls = _to_numpy(boxes.cls).astype(int)

        for (x1, y1, x2, y2), c, k in zip(xyxy, confs, cls, strict=True):
            detections.append({
                "class_name": names[int(k)],
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
                        "class_name": names[int(k)],
                        "confidence": float(c),
                        "points": [[float(p[0]), float(p[1])] for p in poly],
                    })

    return {"detections": detections, "polygons": polygons}


def _to_numpy(arr: Any) -> np.ndarray:
    """Return a numpy array from a torch tensor or list-like."""
    if hasattr(arr, "cpu"):
        return arr.cpu().numpy()
    return np.asarray(arr)
