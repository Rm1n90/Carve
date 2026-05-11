# Armin Mehri — mehri.armin@gmail.com
"""COCO-uncompressed RLE helpers used by the YOLO and COCO export writers.

The ``MaskGeometry`` payload stored in the database carries ``size = (h, w)``
and ``counts`` — a space-separated list of run lengths starting from a 0
run, alternating 0/1 in column-major order (the COCO uncompressed format
the canvas masks were built around).

The export writers need:

* The mask's tight bounding box, so YOLO can emit a sensible bbox label
  and COCO's ``annotations[i].bbox`` is the *real* mask box rather than
  the whole image.
* The mask's foreground pixel count, so COCO's ``annotations[i].area``
  reflects the segmented pixels rather than ``W * H``.

Both helpers are pure Python and avoid pulling pycocotools (a heavy native
dep) into the API container.
"""

from __future__ import annotations


def _decode_runs(counts: str) -> list[int]:
    """Parse the ``counts`` string into a list of integer runs."""
    return [int(tok) for tok in counts.split() if tok]


def rle_to_bbox(
    counts: str, size: tuple[int, int]
) -> tuple[int, int, int, int] | None:
    """Return the mask's tight bbox as ``(x, y, w, h)`` or ``None`` if empty.

    The RLE is column-major: index ``i`` maps to ``(x = i // h, y = i % h)``.
    We only look at the foreground (1) runs and compute the bbox from their
    pixel positions; we never materialise the full mask, which keeps the
    helper O(number of foreground runs) instead of O(h*w).
    """
    h, w = int(size[0]), int(size[1])
    if h <= 0 or w <= 0:
        return None
    runs = _decode_runs(counts)
    if not runs:
        return None
    pos = 0
    val = 0  # COCO RLE: first run is the leading 0s
    min_x = w
    max_x = -1
    min_y = h
    max_y = -1
    for n in runs:
        if val == 1 and n > 0:
            # Foreground run from ``pos`` to ``pos + n - 1`` inclusive.
            start = pos
            end = pos + n - 1
            sx, sy = divmod(start, h)
            ex, ey = divmod(end, h)
            if sx == ex:
                # Same column.
                if sx < min_x:
                    min_x = sx
                if sx > max_x:
                    max_x = sx
                if sy < min_y:
                    min_y = sy
                if ey > max_y:
                    max_y = ey
            else:
                # Spans multiple columns. The first column is sy..h-1, the
                # last column is 0..ey, all middle columns span the full
                # row range — so y range becomes 0..h-1.
                if sx < min_x:
                    min_x = sx
                if ex > max_x:
                    max_x = ex
                min_y = 0
                max_y = h - 1
        pos += n
        val = 1 - val
    if max_x < 0:
        return None
    return (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)


def rle_count_pixels(counts: str) -> int:
    """Sum the lengths of the foreground (1) runs."""
    runs = _decode_runs(counts)
    val = 0
    total = 0
    for n in runs:
        if val == 1:
            total += n
        val = 1 - val
    return total


def rle_to_bitmap(counts: str, size: tuple[int, int]) -> list[list[int]] | None:
    """Decode a column-major COCO RLE to a row-major 2D bitmap of 0/1.

    Returns ``None`` if dimensions are invalid or the RLE is empty.
    Result shape is ``[h][w]`` where ``size == (h, w)``.

    Used by ``rle_to_polygons`` for the YOLO-seg writer. Pure Python so the
    API container avoids a numpy / opencv dependency for export work that
    is already CPU-light per image.
    """
    h, w = int(size[0]), int(size[1])
    if h <= 0 or w <= 0:
        return None
    runs = _decode_runs(counts)
    if not runs:
        return None
    bitmap = [[0] * w for _ in range(h)]
    pos = 0
    val = 0  # COCO RLE: first run is leading 0s
    total = h * w
    for n in runs:
        if val == 1 and n > 0:
            end = min(pos + n, total)
            for i in range(pos, end):
                col = i // h
                row = i % h
                bitmap[row][col] = 1
        pos += n
        val = 1 - val
    return bitmap


def _label_components(
    bitmap: list[list[int]], h: int, w: int,
) -> tuple[list[list[int]], dict[int, int]]:
    """4-connected connected-component labelling.

    Returns ``(labels, areas)`` where ``labels[y][x]`` is the component id
    (1..N, 0 for background) and ``areas[id]`` is the pixel count of that
    component. Iterative flood fill to avoid recursion blow-up on big masks.
    """
    labels: list[list[int]] = [[0] * w for _ in range(h)]
    areas: dict[int, int] = {}
    next_label = 0
    for y in range(h):
        for x in range(w):
            if bitmap[y][x] != 1 or labels[y][x] != 0:
                continue
            next_label += 1
            stack: list[tuple[int, int]] = [(x, y)]
            area = 0
            while stack:
                cx, cy = stack.pop()
                if cx < 0 or cx >= w or cy < 0 or cy >= h:
                    continue
                if labels[cy][cx] != 0 or bitmap[cy][cx] != 1:
                    continue
                labels[cy][cx] = next_label
                area += 1
                stack.append((cx + 1, cy))
                stack.append((cx - 1, cy))
                stack.append((cx, cy + 1))
                stack.append((cx, cy - 1))
            areas[next_label] = area
    return labels, areas


def _trace_component(
    labels: list[list[int]], h: int, w: int, target: int,
) -> list[tuple[int, int]]:
    """Edge-based outer-boundary extraction for one connected component.

    Each foreground pixel contributes up to 4 boundary edges (one per
    side that faces background or the image edge). The edges are
    directed clockwise around the foreground, so chaining them yields
    a closed polygon. Vertices lie on the pixel-corner grid
    (integer coords in ``[0, w] × [0, h]``).

    This handles all blob sizes correctly — including 1×1 components,
    thin strips, and concave shapes — where Moore-neighbor tracing can
    fail to walk the full boundary.
    """
    # Map each vertex to the next vertex along the clockwise outline.
    edges: dict[tuple[int, int], tuple[int, int]] = {}
    for y in range(h):
        for x in range(w):
            if labels[y][x] != target:
                continue
            # Pixel (x, y) occupies grid cell from corner (x, y) to (x+1, y+1).
            # For each side facing background or image edge, add a CW edge.
            # Top (y-1): edge goes left→right along y.
            if y == 0 or labels[y - 1][x] != target:
                edges[(x, y)] = (x + 1, y)
            # Right (x+1): edge goes top→bottom along x+1.
            if x == w - 1 or labels[y][x + 1] != target:
                edges[(x + 1, y)] = (x + 1, y + 1)
            # Bottom (y+1): edge goes right→left along y+1.
            if y == h - 1 or labels[y + 1][x] != target:
                edges[(x + 1, y + 1)] = (x, y + 1)
            # Left (x-1): edge goes bottom→top along x.
            if x == 0 or labels[y][x - 1] != target:
                edges[(x, y + 1)] = (x, y)
    if not edges:
        return []
    # Start at the top-leftmost vertex and walk CW until we return.
    start = min(edges.keys())
    contour: list[tuple[int, int]] = [start]
    cur = edges[start]
    safety = len(edges) + 8
    while cur != start and cur in edges and safety > 0:
        contour.append(cur)
        cur = edges[cur]
        safety -= 1
    # Simplify collinear runs so 2x2 blocks become 4-vertex squares
    # instead of 8-vertex octagons. YOLO accepts both, but fewer
    # vertices = smaller label files and cleaner training data.
    return _simplify_collinear(contour)


def _simplify_collinear(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Drop intermediate vertices that lie on a straight horizontal/vertical line."""
    if len(points) < 3:
        return points
    out: list[tuple[int, int]] = [points[0]]
    n = len(points)
    for i in range(1, n):
        prev = out[-1]
        cur = points[i]
        nxt = points[(i + 1) % n]
        # If prev → cur → nxt is collinear (horizontal or vertical),
        # drop cur.
        if (prev[0] == cur[0] == nxt[0]) or (prev[1] == cur[1] == nxt[1]):
            continue
        out.append(cur)
    return out


def rle_to_polygons(
    counts: str,
    size: tuple[int, int],
    *,
    min_area: int = 4,
) -> list[list[tuple[float, float]]]:
    """Extract outer-boundary polygon(s) from a column-major COCO RLE.

    One polygon per 4-connected component whose pixel area is at least
    ``min_area``. Coordinates are integer pixel positions expressed as
    floats so the caller can normalise by image width/height. Each
    polygon is implicitly closed (the consumer should not append the
    first point at the end).

    Returns ``[]`` if the RLE is empty or every component is smaller
    than ``min_area``. Components that yield fewer than 3 boundary
    points (e.g. a 1×N strip) are silently dropped — YOLO-seg requires
    at least 3 vertices per polygon line.
    """
    bitmap = rle_to_bitmap(counts, size)
    if bitmap is None:
        return []
    h = len(bitmap)
    w = len(bitmap[0]) if h > 0 else 0
    if w == 0:
        return []
    labels, areas = _label_components(bitmap, h, w)
    polygons: list[list[tuple[float, float]]] = []
    for lbl in range(1, max(areas, default=0) + 1):
        if areas.get(lbl, 0) < min_area:
            continue
        contour = _trace_component(labels, h, w, lbl)
        if len(contour) < 3:
            continue
        polygons.append([(float(x), float(y)) for x, y in contour])
    return polygons
