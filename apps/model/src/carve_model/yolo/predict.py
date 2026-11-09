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

    Segmentation models: each mask comes back once, as a polygon when it is
    one piece without holes, else as a ``mask_rle`` entry in ``masks``. Both
    carry ``det``, the index of their detection, so callers can store the
    shape instead of the box.
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
    mask_list: list[dict] = []

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

        if masks is not None and getattr(masks, "data", None) is not None:
            data = _to_numpy(masks.data)
            h0, w0 = img.shape[:2]
            for i, (k, c) in enumerate(zip(cls, confs, strict=True)):
                shape = _mask_shape(data[i], h0, w0)
                if shape is None:
                    continue
                kind, value = shape
                entry = {"class_name": names[int(k)], "confidence": float(c), "det": i}
                if kind == "polygon":
                    polygons.append({**entry, "points": value})
                else:
                    mask_list.append({**entry, **value})
        elif masks is not None:
            mask_xy = getattr(masks, "xy", None)
            if mask_xy is not None:
                for i, (poly, k, c) in enumerate(zip(mask_xy, cls, confs, strict=True)):
                    polygons.append({
                        "class_name": names[int(k)],
                        "confidence": float(c),
                        "det": i,
                        "points": [[float(p[0]), float(p[1])] for p in poly],
                    })

    return {"detections": detections, "polygons": polygons, "masks": mask_list}


# A mask piece smaller than PART_MIN of its whole mask is a stray speck and is
# dropped; a hole smaller than HOLE_MIN is noise and is filled. The same idea
# as the SAM box conversion (sam/box_convert.py), with a lower part floor: a
# YOLO mask splits into real pieces more often (a person cut by a ball, a pitch
# cut by players).
PART_MIN = 0.02
HOLE_MIN = 0.01
MIN_PIXELS = 16


def _mask_shape(m: np.ndarray, h0: int, w0: int) -> tuple[str, Any] | None:
    """One instance mask (at the model's letterboxed input size) as Carve
    geometry in original-image pixels.

    One piece without holes → ``("polygon", points)``. Anything else →
    ``("mask", {"size": [h0, w0], "counts": rle})``: Ultralytics' own
    ``masks.xy`` joins the pieces into one outline with zero-width bridges
    (drawn as stray lines) and drops every hole, so those shapes stay pixel
    masks instead. ``None`` when nothing is left.

    Works on the object's own region of the mask, not the whole frame: a
    frame holds dozens of masks and most objects are small.
    """
    import cv2

    m = (np.asarray(m) > 0.5).astype(np.uint8)
    bx, by, bw, bh = cv2.boundingRect(m)
    if bw == 0 or bh == 0:
        return None
    h1, w1 = m.shape
    x0, y0 = max(bx - 1, 0), max(by - 1, 0)  # keep a 1 px empty border round the object
    sub = np.ascontiguousarray(m[y0:min(by + bh + 1, h1), x0:min(bx + bw + 1, w1)])
    total = int(sub.sum())
    n, labels, stats, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    floor = max(MIN_PIXELS, PART_MIN * total)
    keep = [j + 1 for j, a in enumerate(areas) if a >= floor] or [int(np.argmax(areas)) + 1]
    lut = np.zeros(n, np.uint8)
    lut[keep] = 1
    sub = lut[labels]
    holes = _fill_holes(sub) - sub
    has_hole = False
    if holes.any():
        hn, hl, hs, _ = cv2.connectedComponentsWithStats(holes, connectivity=4)
        small = hs[:, cv2.CC_STAT_AREA] < max(MIN_PIXELS, HOLE_MIN * total)
        small[0] = False
        sub = sub | small[hl].astype(np.uint8)
        has_hole = bool((~small[1:]).any())
    # Undo the letterbox exactly as ultralytics.utils.ops.scale_coords /
    # scale_masks do.
    gain = min(h1 / h0, w1 / w0)
    pad_w, pad_h = (w1 - round(w0 * gain)) / 2, (h1 - round(h0 * gain)) / 2
    if len(keep) == 1 and not has_hole:
        cnts, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
        if len(c) < 3:
            return None
        x = np.clip((c[:, 0] + x0 - pad_w) / gain, 0, w0)
        y = np.clip((c[:, 1] + y0 - pad_h) / gain, 0, h0)
        return "polygon", [[float(a), float(b)] for a, b in zip(x, y, strict=True)]
    # Scale the region to original pixels with the same sampling as resizing
    # the whole letterbox-cropped mask (cv2.resize, bilinear, > 0.5).
    top, left = round(pad_h - 0.1), round(pad_w - 0.1)
    bottom, right = h1 - round(pad_h + 0.1), w1 - round(pad_w + 0.1)
    sx, sy = w0 / (right - left), h0 / (bottom - top)
    rx, ry = x0 - left, y0 - top  # region origin in the cropped mask
    rh, rw = sub.shape
    gx0 = max(0, int(np.floor((rx - 0.5) * sx - 0.5)))
    gy0 = max(0, int(np.floor((ry - 0.5) * sy - 0.5)))
    gx1 = min(w0, int(np.ceil((rx + rw + 0.5) * sx)))
    gy1 = min(h0, int(np.ceil((ry + rh + 0.5) * sy)))
    if gx1 <= gx0 or gy1 <= gy0:
        return None
    to_src = np.array([
        [1 / sx, 0, (gx0 + 0.5) / sx - 0.5 - rx],
        [0, 1 / sy, (gy0 + 0.5) / sy - 0.5 - ry],
    ])
    region = cv2.warpAffine(
        sub.astype(np.float32), to_src, (gx1 - gx0, gy1 - gy0),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE,
    ) > 0.5
    if not region.any():
        return None
    return "mask", {"size": [h0, w0], "counts": _rle_region(region, gx0, gy0, h0, w0)}


def _rle_region(region: np.ndarray, x0: int, y0: int, h: int, w: int) -> str:
    """Carve's mask_rle (column-major runs, starting with a background run,
    comma-separated, as ``sam.router._rle`` writes it) of an h x w mask that
    is empty outside ``region`` placed at (x0, y0). Only the columns the
    region spans are walked."""
    rh, rw = region.shape
    cols = np.zeros((h, rw), np.int8)
    cols[y0:y0 + rh] = region
    flat = cols.T.reshape(-1)
    edges = np.flatnonzero(np.diff(flat)) + 1
    runs = np.diff(np.concatenate(([0], edges, [flat.size]))).tolist()
    if flat[0] == 1:
        runs.insert(0, 0)
    runs[0] += x0 * h  # empty columns before the region
    after = (w - x0 - rw) * h  # and after it
    if len(runs) % 2:
        runs[-1] += after
    elif after:
        runs.append(after)
    return ",".join(map(str, runs))


def _fill_holes(m: np.ndarray) -> np.ndarray:
    import cv2

    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m)
    cv2.drawContours(out, cnts, -1, 1, thickness=cv2.FILLED)
    return out


def _to_numpy(arr: Any) -> np.ndarray:
    """Return a numpy array from a torch tensor or list-like."""
    if hasattr(arr, "cpu"):
        return arr.cpu().numpy()
    return np.asarray(arr)
