"""A mask annotation as one YOLO-seg polygon: pieces and holes kept,
filled back it is the mask again, and the outline stays within the
points Ultralytics keeps."""

from types import SimpleNamespace

import cv2
import numpy as np

from carve_api.annotations.models import AnnotationKind
from carve_api.exports.job import _convert_for_yolo_mode
from carve_api.io.mask_polygon import MAX_VERTICES, decode_rle, mask_to_polygon, mask_to_polygons
from carve_api.io.rle import coco_counts_to_runs, rle_to_bitmap


def _rle(mask: np.ndarray) -> str:
    flat = mask.T.reshape(-1)
    runs, val, n = [], 0, 0
    for v in flat:
        if v == val:
            n += 1
        else:
            runs.append(n)
            val, n = v, 1
    runs.append(n)
    return ",".join(map(str, runs))


def _fill(poly, h: int, w: int) -> np.ndarray:
    """What a trainer draws from the polygon (Ultralytics uses fillPoly)."""
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(poly)).astype(np.int32)], 1)
    return m


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum()) / float((a | b).sum())


def test_pieces_and_holes_become_one_polygon_that_fills_back_to_the_mask() -> None:
    m = np.zeros((200, 300), np.uint8)
    m[20:180, 20:140] = 1
    m[60:120, 50:110] = 0          # a player cut out of the ground: a hole
    m[40:160, 180:280] = 1          # a second piece (split by a pole)
    poly = mask_to_polygon(m)
    assert poly is not None
    back = _fill(poly, 200, 300)
    assert back[90, 80] == 0        # the hole stays open
    assert back[100, 30] == 1 and back[100, 230] == 1   # both pieces, one instance
    assert _iou(back, m) > 0.97


def test_specks_are_dropped_and_an_empty_mask_gives_nothing() -> None:
    m = np.zeros((100, 100), np.uint8)
    m[10:60, 10:60] = 1
    m[80, 80] = 1                   # a one-pixel speck
    poly = mask_to_polygon(m)
    xs = [p[0] for p in poly]
    assert max(xs) < 70
    assert mask_to_polygon(np.zeros((50, 50), np.uint8)) is None


def test_a_crowd_of_many_pieces_stays_within_the_points_ultralytics_keeps() -> None:
    rng = np.random.default_rng(0)
    m = np.zeros((1080, 1920), np.uint8)
    for _ in range(40):             # spectators in a stand, ragged outlines
        x, y = int(rng.integers(600, 1300)), int(rng.integers(200, 600))
        axes = (int(rng.integers(6, 20)), int(rng.integers(10, 30)))
        cv2.ellipse(m, (x, y), axes, float(rng.integers(0, 180)), 0, 360, 1, -1)
    polys = mask_to_polygons(m)
    assert len(polys) == 1 and len(polys[0]) <= MAX_VERTICES
    assert _iou(_fill(polys[0], 1080, 1920), m) > 0.95


def test_hundreds_of_pieces_become_a_few_instances_and_lose_nothing() -> None:
    rng = np.random.default_rng(0)
    m = np.zeros((1080, 1920), np.uint8)
    for _ in range(300):
        x, y = int(rng.integers(0, 1880)), int(rng.integers(0, 1040))
        axes = (int(rng.integers(6, 20)), int(rng.integers(10, 30)))
        cv2.ellipse(m, (x, y), axes, float(rng.integers(0, 180)), 0, 360, 1, -1)
    polys = mask_to_polygons(m)
    assert 1 < len(polys) < 10
    assert all(len(p) <= MAX_VERTICES for p in polys)
    back = np.zeros_like(m)
    for p in polys:
        back |= _fill(p, 1080, 1920)
    # Nothing is lost; what is added is the 1-px cuts drawn between pieces
    # scattered over the whole frame.
    assert (m & back).sum() / m.sum() > 0.95   # tiny ellipses lose their rim to 1.5 px chords
    assert (m & back).sum() / back.sum() > 0.8


def test_rle_decoding_matches_the_reference_decoder() -> None:
    rng = np.random.default_rng(1)
    m = (rng.random((37, 53)) > 0.6).astype(np.uint8)
    counts = _rle(m)
    assert (decode_rle(counts, (37, 53)) == m).all()
    assert (np.asarray(rle_to_bitmap(counts, (37, 53))) == m).all()


def test_the_seg_export_writes_one_line_per_mask_annotation() -> None:
    m = np.zeros((100, 200), np.uint8)
    m[10:90, 10:80] = 1
    m[10:90, 120:190] = 1
    ann = SimpleNamespace(kind=AnnotationKind.mask, class_id="c",
                          geometry={"kind": "mask_rle", "size": [100, 200], "counts": _rle(m)})
    out = _convert_for_yolo_mode([ann], "segmentation", (400, 200))
    assert len(out) == 1 and out[0].kind == AnnotationKind.polygon
    xs = [p[0] for p in out[0].geometry["points"]]
    assert max(xs) > 300            # rescaled from the mask's 200 px to the asset's 400


def _coco_compress(cnts: list[int]) -> str:
    """pycocotools' rleToString, for the round trip."""
    s = []
    for i, x in enumerate(cnts):
        if i > 2:
            x -= cnts[i - 2]
        more = True
        while more:
            c = x & 0x1F
            x >>= 5
            more = (x != -1) if (c & 0x10) else (x != 0)
            if more:
                c |= 0x20
            s.append(chr(c + 48))
    return "".join(s)


def test_coco_counts_are_read_in_every_form() -> None:
    runs = [3, 5, 120, 7, 2, 40]
    assert coco_counts_to_runs(runs) == "3,5,120,7,2,40"
    assert coco_counts_to_runs("3,5,120,7,2,40") == "3,5,120,7,2,40"
    assert coco_counts_to_runs("3 5 120") == "3 5 120"
    assert coco_counts_to_runs(_coco_compress(runs)) == "3,5,120,7,2,40"
