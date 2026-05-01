"""Mask -> editable polygon conversion.

SAM emits a binary mask per click; the editor needs an editable polygon so
the user can drag vertices via the existing polygon edit machinery (see
``apps/web/src/canvas/polygonEdit.ts``). We compute the polygon server-side
because (a) cv2 is already a model service dependency, (b) doing it once
near the model avoids shipping a marching-squares implementation to the
browser, and (c) the simplified vertex list is far smaller on the wire than
a full RLE.

For v1 we keep only the largest external contour. Holes (RETR_CCOMP) and
multi-region masks are deferred -- they show up rarely with a single
positive click and complicate the editable representation. ``epsilon`` is
expressed as a fraction of the contour's arc length so the simplification
scales with object size: a fixed pixel epsilon over-simplifies small
objects and under-simplifies large ones.
"""

from __future__ import annotations

import cv2
import numpy as np


DEFAULT_EPSILON_FACTOR = 0.0015


def mask_to_polygon(
    mask: np.ndarray,
    epsilon_factor: float = DEFAULT_EPSILON_FACTOR,
) -> list[list[float]]:
    """Return a Douglas-Peucker simplified polygon for the largest blob.

    ``mask`` is a 2-D array; non-zero pixels are foreground. Returns
    ``[[x, y], ...]`` in image coordinates, or ``[]`` when the mask is
    empty / has no detectable contour. The polygon is implicitly closed
    (last vertex connects to first); the closing vertex is not duplicated.
    """
    if mask.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {mask.shape}")
    binary = (mask > 0).astype(np.uint8)
    if not binary.any():
        return []

    contours, _ = cv2.findContours(
        binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
    )
    if not contours:
        return []

    largest = max(contours, key=cv2.contourArea)
    # Degenerate single-pixel / line contours simplify to <3 vertices and
    # cannot be edited as a polygon. Drop them so the client never sees
    # an unusable shape.
    if cv2.contourArea(largest) < 1.0:
        return []

    eps = epsilon_factor * cv2.arcLength(largest, closed=True)
    simplified = cv2.approxPolyDP(largest, eps, closed=True)
    pts = simplified.reshape(-1, 2)
    if pts.shape[0] < 3:
        return []
    return pts.astype(float).tolist()
