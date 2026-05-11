"""Tests for the pure-Python mask→polygon helpers used by the YOLO-seg writer."""

from carve_api.io.rle import rle_to_bitmap, rle_to_polygons


def test_rle_to_bitmap_decodes_top_left_2x2_block() -> None:
    # 10x10 image, 2x2 block at top-left, column-major encoding.
    bitmap = rle_to_bitmap("0 2 8 2 86", (10, 10))
    assert bitmap is not None
    assert bitmap[0][0] == 1
    assert bitmap[1][0] == 1
    assert bitmap[0][1] == 1
    assert bitmap[1][1] == 1
    assert bitmap[2][0] == 0
    assert bitmap[0][2] == 0


def test_rle_to_polygons_single_block() -> None:
    polys = rle_to_polygons("0 2 8 2 86", (10, 10))
    assert len(polys) == 1
    poly = polys[0]
    # 2x2 block at top-left → outline on pixel-corner grid is the
    # rectangle (0,0)-(2,0)-(2,2)-(0,2).
    assert len(poly) == 4
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    assert min(xs) == 0
    assert max(xs) == 2
    assert min(ys) == 0
    assert max(ys) == 2


def test_rle_to_polygons_two_components() -> None:
    """A mask with two disjoint blobs should produce two polygons."""
    h, w = 10, 10
    fg = [(0, 0), (0, 1), (1, 0), (1, 1), (8, 8), (8, 9), (9, 8), (9, 9)]
    bm = [[0] * w for _ in range(h)]
    for x, y in fg:
        bm[y][x] = 1
    # Column-major encode.
    runs: list[int] = []
    cur = 0
    n = 0
    for col in range(w):
        for row in range(h):
            v = bm[row][col]
            if v == cur:
                n += 1
            else:
                runs.append(n)
                cur = v
                n = 1
    runs.append(n)
    counts = " ".join(str(r) for r in runs)
    polys = rle_to_polygons(counts, (h, w))
    assert len(polys) == 2


def test_rle_to_polygons_empty() -> None:
    assert rle_to_polygons("100", (10, 10)) == []
    assert rle_to_polygons("", (10, 10)) == []


def test_rle_to_polygons_below_min_area_dropped() -> None:
    # Single foreground pixel — below the default min_area of 4.
    polys = rle_to_polygons("1 1 98", (10, 10))
    assert polys == []
