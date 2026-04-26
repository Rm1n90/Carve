"""Run a YOLO model over a single image and shape the output.

The function accepts any model object implementing ``predict(np.ndarray, **kwargs)``
returning a ``Results``-like object with ``boxes``, optional ``masks``, and
``names``. Production code passes an Ultralytics ``YOLO`` instance.
"""

import io
from typing import Any

import numpy as np
from PIL import Image


def predict_image(
    model: Any,
    image_bytes: bytes,
    *,
    conf: float = 0.25,
    iou: float = 0.7,
) -> dict:
    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    results = model.predict(img, conf=conf, iou=iou, verbose=False)[0]

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
