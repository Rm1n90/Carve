# Armin Mehri — mehri.armin@gmail.com
"""A mask annotation as one YOLO-seg polygon.

YOLO-seg has one polygon per instance and no holes or pieces. A mask
(ground, crowd, an object split by something in front of it, ropes) is
one instance with holes and several pieces, so it is written as one
polygon that visits every piece and every hole: pieces and holes are
joined by zero-width cuts along the shortest gaps, the holes running
the other way round. Filled, that polygon is the mask again, holes open,
and the instance stays one instance (one box, one mask) in training.

Outlines are simplified as little as needed to stay within
``MAX_VERTICES``: Ultralytics resamples every instance to 1000 points and
keeps them all when there are fewer, so under that budget training sees
the exact outline. A mask of so many pieces that even that is not enough
(hundreds of separate spectators) is written as a few instances of
neighbouring pieces, each within the budget, rather than leave the
trainer to drop every other point of every outline.
"""

from __future__ import annotations

import cv2
import numpy as np

from carve_api.io.rle import _decode_runs

# Ultralytics' segment resampling: fewer points are all kept.
MAX_VERTICES = 1000
# Simplification tolerances (pixels), tried in order until the outline
# fits the budget. 0.5 px only removes the pixel staircase; 1.5 px is a
# fifth of a mask pixel when a 1080p frame is trained at 1024. Pieces that
# still do not fit go to separate instances rather than lose more.
EPSILONS = (0.5, 0.75, 1.0, 1.5)
# A single piece over the budget on its own (a ground with very many
# holes) is simplified further, up to half a mask pixel.
PIECE_EPSILONS = (2.0, 3.0, 4.0)
# Pieces and holes smaller than this (pixels) are segmenter specks.
MIN_PIECE_PX = 9
MIN_HOLE_PX = 9


def decode_rle(counts: str, size: tuple[int, int]) -> np.ndarray | None:
    """Column-major RLE (comma- or space-separated runs) to an HxW uint8 mask."""
    h, w = int(size[0]), int(size[1])
    runs = _decode_runs(counts)
    if h <= 0 or w <= 0 or not runs:
        return None
    vals = np.zeros(len(runs), dtype=np.uint8)
    vals[1::2] = 1
    flat = np.repeat(vals, np.asarray(runs, dtype=np.int64))[: h * w]
    if flat.size < h * w:
        flat = np.pad(flat, (0, h * w - flat.size))
    return np.ascontiguousarray(flat.reshape(w, h).T)


def _pixel_area(contour: np.ndarray) -> float:
    """Pixels inside an outline traced through pixel centres."""
    return cv2.contourArea(contour) + cv2.arcLength(contour, True) / 2 + 1


def _splice(poly: np.ndarray, part: np.ndarray) -> np.ndarray:
    """Join ``part`` into ``poly`` by a zero-width cut at their closest points."""
    d = ((poly[:, None, :] - part[None, :, :]) ** 2).sum(axis=2)
    a, b = np.unravel_index(int(np.argmin(d)), d.shape)
    part = np.roll(part, -int(b), axis=0)
    return np.concatenate([poly[: a + 1], part, part[:1], poly[a : a + 1], poly[a + 1 :]])


def _oriented(c: np.ndarray, positive: bool) -> np.ndarray:
    area = cv2.contourArea(c.astype(np.float32), oriented=True)
    return c if (area >= 0) == positive else c[::-1]


def _pieces(m: np.ndarray) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """Outer outlines (largest first), each with its holes; specks dropped."""
    contours, hierarchy = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    tree = hierarchy[0]
    pieces: list[tuple[np.ndarray, list[np.ndarray]]] = []
    for i, c in enumerate(contours):
        if tree[i][3] != -1 or _pixel_area(c) < MIN_PIECE_PX:
            continue
        holes = []
        j = tree[i][2]  # first hole, then its siblings
        while j != -1:
            if cv2.contourArea(contours[j]) >= MIN_HOLE_PX:
                holes.append(contours[j])
            j = tree[j][0]
        pieces.append((c, holes))
    pieces.sort(key=lambda p: -cv2.contourArea(p[0]))
    return pieces


Simple = list[tuple[np.ndarray, list[np.ndarray]]]


def _simplify(pieces, eps: float) -> tuple[Simple, int]:
    """The outlines at tolerance ``eps``, and the points the joined polygon
    will have (two more per cut)."""
    out: Simple = []
    for c, hs in pieces:
        oc = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(oc) < 3:
            continue
        oh = [cv2.approxPolyDP(hc, eps, True).reshape(-1, 2) for hc in hs]
        oh = [h for h in oh if len(h) >= 3]
        out.append((oc, oh))
    parts = sum(1 + len(hs) for _, hs in out)
    return out, sum(len(c) + sum(len(h) for h in hs) for c, hs in out) + 2 * max(0, parts - 1)


def _fit(m: np.ndarray) -> Simple:
    """Outlines simplified as little as it takes to fit MAX_VERTICES; when
    they cannot all fit, each piece on its own does (the caller splits)."""
    pieces = _pieces(m)
    for eps in EPSILONS:
        simple, total = _simplify(pieces, eps)
        if total <= MAX_VERTICES:
            return simple
    out: Simple = []
    for piece in pieces:
        for eps in PIECE_EPSILONS:
            one, size = _simplify([piece], eps)
            if size <= MAX_VERTICES:
                break
        smallest, size = _simplify([piece], EPSILONS[-1])
        out.extend(smallest if size <= MAX_VERTICES else one)
    return out


def mask_to_polygons(mask: np.ndarray) -> list[list[tuple[float, float]]]:
    """The mask as one polygon (pixel coordinates); several only when its
    pieces cannot fit MAX_VERTICES together. Empty when it has no piece
    bigger than a speck."""
    simple = _fit((mask > 0).astype(np.uint8))
    outlines = []
    for c, hs in simple:
        outline = _oriented(c.astype(np.float64), True)
        # Each hole joins its own piece (the cut runs through the piece).
        for hc in sorted(hs, key=lambda hc: -len(hc)):
            outline = _splice(outline, _oriented(hc.astype(np.float64), False))
        outlines.append(outline)
    if not outlines:
        return []
    # The pieces nearest first from the largest, so the cuts stay short
    # (each piece's distance to what is joined so far is kept up to date).
    order = [outlines[0]]
    rest = outlines[1:]
    best = [_gap(order[0], r) for r in rest]
    while rest:
        k = int(np.argmin(best))
        piece = rest.pop(k)
        best.pop(k)
        order.append(piece)
        best = [min(b, _gap(piece, r)) for b, r in zip(best, rest, strict=True)]
    # Joined in that order, a new polygon starting where the budget is full.
    polygons: list[np.ndarray] = []
    for piece in order:
        if polygons and len(polygons[-1]) + len(piece) + 2 <= MAX_VERTICES:
            polygons[-1] = _splice(polygons[-1], piece)
        else:
            polygons.append(piece)
    return [[(float(x), float(y)) for x, y in poly] for poly in polygons]


def mask_to_polygon(mask: np.ndarray) -> list[tuple[float, float]] | None:
    """The mask as one polygon when it fits the budget (see
    ``mask_to_polygons``), else the first of its polygons."""
    polys = mask_to_polygons(mask)
    return polys[0] if polys else None


def _gap(a: np.ndarray, b: np.ndarray) -> float:
    return float(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2).min())


def rle_to_instance_polygons(counts: str, size: tuple[int, int]) -> list[list[tuple[float, float]]]:
    mask = decode_rle(counts, size)
    return mask_to_polygons(mask) if mask is not None else []
