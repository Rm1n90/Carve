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
