"""Preprocessing helpers for SAM visual prompt encoding.

See docs/superpowers/specs/2026-05-08-sam-visual-prompt-design.md Section 5.6.
"""
from __future__ import annotations

import numpy as np


def expand_region_with_padding(region, *, image_h, image_w, pad_ratio=0.15):
    """Expand a bounding box or polygon region by a padding ratio.

    For bbox regions, returns an expanded bbox clipped to image bounds.
    For polygon regions, returns the original polygon with a crop_xyxy field.

    Args:
        region: Dict with "kind" ("bbox" or "polygon") and shape data
        image_h: Image height in pixels
        image_w: Image width in pixels
        pad_ratio: Padding ratio relative to region width/height (default 0.15)

    Returns:
        Region dict with expanded coordinates (or crop_xyxy for polygons)
    """
    if region["kind"] == "bbox":
        x1, y1, x2, y2 = (float(v) for v in region["xyxy"])
        w = x2 - x1
        h = y2 - y1
    elif region["kind"] == "polygon":
        pts = np.asarray(region["points"], dtype=float)
        x1, y1 = pts[:, 0].min(), pts[:, 1].min()
        x2, y2 = pts[:, 0].max(), pts[:, 1].max()
        w = x2 - x1
        h = y2 - y1
    else:
        raise ValueError(f"unknown region kind: {region['kind']!r}")

    pad_x = w * pad_ratio
    pad_y = h * pad_ratio
    nx1 = max(0.0, x1 - pad_x)
    ny1 = max(0.0, y1 - pad_y)
    nx2 = min(float(image_w), x2 + pad_x)
    ny2 = min(float(image_h), y2 + pad_y)

    if region["kind"] == "bbox":
        return {"kind": "bbox", "xyxy": [nx1, ny1, nx2, ny2]}
    return {
        "kind": "polygon",
        "points": [list(p) for p in region["points"]],
        "crop_xyxy": [nx1, ny1, nx2, ny2],
    }


def min_size_guard(crop_xyxy, min_side=64):
    """Expand a crop box to a minimum size if needed.

    Centers the expansion around the crop's center point.

    Args:
        crop_xyxy: [x1, y1, x2, y2] bounding box
        min_side: Minimum width and height (default 64)

    Returns:
        Expanded [x1, y1, x2, y2] with width >= min_side and height >= min_side
    """
    x1, y1, x2, y2 = (float(v) for v in crop_xyxy)
    w = x2 - x1
    h = y2 - y1
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    nw = max(w, float(min_side))
    nh = max(h, float(min_side))
    return [cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2]


def rasterise_polygon(points, h, w):
    """Convert a polygon to a binary mask.

    Uses cv2.fillPoly if available, otherwise falls back to numpy rasterization.

    Args:
        points: List of [x, y] vertices
        h: Image height
        w: Image width

    Returns:
        Boolean mask array of shape (h, w)
    """
    pts = np.asarray(points, dtype=float)
    if len(pts) < 3:
        return np.zeros((h, w), dtype=bool)
    try:
        import cv2  # type: ignore[import-not-found]
        mask = np.zeros((h, w), dtype=np.uint8)
        pts_int = np.asarray(points, dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(mask, [pts_int], color=1)
        return mask.astype(bool)
    except ImportError:
        return _numpy_polygon_raster(points, h, w)


def _numpy_polygon_raster(points, h, w):
    """Rasterize a polygon using numpy (point-in-polygon via ray casting).

    Args:
        points: List of [x, y] vertices
        h: Image height
        w: Image width

    Returns:
        Boolean mask array of shape (h, w)
    """
    pts = np.asarray(points, dtype=float)
    n = len(pts)
    mask = np.zeros((h, w), dtype=bool)
    if n < 3:
        return mask
    ys = np.arange(h)[:, None]
    xs = np.arange(w)[None, :]
    inside = np.zeros((h, w), dtype=bool)
    j = n - 1
    for i in range(n):
        yi, xi = pts[i, 1], pts[i, 0]
        yj, xj = pts[j, 1], pts[j, 0]
        cond = ((yi > ys) != (yj > ys)) & (
            xs < (xj - xi) * (ys - yi) / (yj - yi + 1e-12) + xi
        )
        inside ^= cond
        j = i
    return inside


def square_pad_replicate(crop):
    """Pad an image crop to square dimensions using edge replication.

    Centers the crop in the output. Uses numpy edge padding to replicate border pixels.

    Args:
        crop: Array of shape (h, w, c) or (h, w)

    Returns:
        Padded array of shape (side, side, c) or (side, side) where side = max(h, w)
    """
    h, w = crop.shape[:2]
    if h == w:
        return crop
    side = max(h, w)
    pad_top = (side - h) // 2
    pad_bot = side - h - pad_top
    pad_left = (side - w) // 2
    pad_right = side - w - pad_left
    return np.pad(
        crop,
        ((pad_top, pad_bot), (pad_left, pad_right), (0, 0)),
        mode="edge",
    )
