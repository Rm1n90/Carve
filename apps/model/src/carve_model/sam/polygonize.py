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


# Plan-20.14 — was 0.0015. Even SAM 3.1's near-pixel-perfect masks
# collapsed to a visibly coarse polygon at that tolerance — fingers,
# ears, and small concavities were being smoothed out. 0.0008 doubles
# the vertex budget for the same arc length, so the polygon traces
# the mask edge faithfully while staying small on the wire and
# editable in the polygon-edit tool.
DEFAULT_EPSILON_FACTOR = 0.0008

# v3.22 — morphological cleanup before contour extraction. SAM's mask
# logits often have low-confidence pixels along the boundary that, after
# binarization, look like 1–2 px wide spikes snaking into excluded
# regions (very visible when the user added negative clicks and still
# saw thin tendrils on the wrong object). A 3×3 OPEN deletes every
# spike ≤1 px wide; a 3×3 CLOSE then fills 1-px holes the open just
# opened, so the bulk shape is preserved. After cleanup we also keep
# only the largest 8-connected component, which suppresses isolated
# noise blobs.
DEFAULT_CLEANUP_KERNEL = 3


def cleanup_mask(
    mask: np.ndarray,
    kernel: int = DEFAULT_CLEANUP_KERNEL,
    fill_holes: bool = False,
) -> np.ndarray:
    """Return a cleaned binary uint8 mask.

    Applies binary OPEN + CLOSE with a ``kernel`` × ``kernel`` square,
    then keeps only the largest 8-connected component. ``kernel < 2``
    disables the morphological pass (only the connected-component
    filter runs). Returns the original binary cast when no foreground
    is present.

    v3.22 — when ``fill_holes=True`` any internal background hole
    inside the foreground component is filled. Use this only when no
    negative click is present: a negative click is the user's signal
    that they WANT a hole in that region, and filling would defeat it.
    The router passes ``fill_holes=not has_negative``.

    Used by /sam/decode (and other prompt routes) so BOTH the mask RLE
    that the editor renders AND the polygon derived from it come from
    the same de-spiked source.
    """
    if mask.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {mask.shape}")
    binary = (mask > 0).astype(np.uint8)
    if not binary.any():
        return binary

    if kernel and kernel >= 2:
        k = int(kernel)
        struct = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, struct)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, struct)
        if not binary.any():
            return binary

    n_components, labels = cv2.connectedComponents(binary, connectivity=8)
    if n_components > 2:
        sizes = np.bincount(labels.ravel())
        sizes[0] = 0
        largest_label = int(sizes.argmax())
        binary = (labels == largest_label).astype(np.uint8)

    if fill_holes and binary.any():
        # findContours with RETR_EXTERNAL ignores internal holes; drawing
        # those external contours back as FILLED produces a solid mask.
        # Equivalent to scipy.ndimage.binary_fill_holes but uses cv2 only.
        contours, _ = cv2.findContours(
            binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        if contours:
            filled = np.zeros_like(binary)
            cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
            binary = filled

    return binary


def mask_to_polygon(
    mask: np.ndarray,
    epsilon_factor: float = DEFAULT_EPSILON_FACTOR,
    cleanup_kernel: int = DEFAULT_CLEANUP_KERNEL,
) -> list[list[float]]:
    """Return a Douglas-Peucker simplified polygon for the largest blob.

    ``mask`` is a 2-D array; non-zero pixels are foreground. Returns
    ``[[x, y], ...]`` in image coordinates, or ``[]`` when the mask is
    empty / has no detectable contour. The polygon is implicitly closed
    (last vertex connects to first); the closing vertex is not duplicated.

    v3.22 — when ``cleanup_kernel >= 2`` a binary OPEN+CLOSE pass runs
    before contour extraction to delete sub-pixel-wide spikes along the
    SAM mask boundary, then only the largest 8-connected component is
    kept. Pass ``cleanup_kernel=0`` to bypass when the upstream mask is
    already clean (tracker output, etc).
    """
    if mask.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {mask.shape}")
    binary = (mask > 0).astype(np.uint8)
    if not binary.any():
        return []

    if cleanup_kernel and cleanup_kernel >= 2:
        k = int(cleanup_kernel)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        if not binary.any():
            return []

        # Keep only the largest 8-connected component. cv2.connectedComponents
        # is O(n) and avoids running findContours twice.
        n_components, labels = cv2.connectedComponents(binary, connectivity=8)
        if n_components > 2:  # > 1 background + 1 foreground
            sizes = np.bincount(labels.ravel())
            sizes[0] = 0  # exclude background
            largest_label = int(sizes.argmax())
            binary = (labels == largest_label).astype(np.uint8)

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
