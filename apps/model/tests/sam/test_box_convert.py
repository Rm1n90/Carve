"""Boxes -> polygons: crop planning, clipping and the zoomed path."""

import numpy as np

from carve_model.sam import box_convert as bc


class _Seg:
    """A stand-in predictor: the 'mask' of any box is every bright pixel
    of the image currently set, wherever it is, so the tests can see
    clipping and the crop-to-image mapping at work."""

    def __init__(self) -> None:
        self.image: np.ndarray | None = None
        self.sets: list[tuple[int, int]] = []
        self.boxes: list[list[float]] = []

    def set_image(self, img: np.ndarray) -> None:
        self.image = img
        self.sets.append(img.shape[:2])

    def predict_box(self, box: np.ndarray) -> tuple[np.ndarray, float]:
        self.boxes.append([float(v) for v in box])
        return (self.image[..., 0] > 128).astype(np.uint8), 0.9


def _raster(r: bc.BoxResult, h: int, w: int) -> np.ndarray:
    """A result as pixels, whether it came back as a mask or a polygon."""
    if r.mask is not None:
        return r.mask
    import cv2
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(r.polygon)).astype(np.int32)], 1)
    return m


def _scene(h: int = 1080, w: int = 1920) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[500:540, 900:920] = 255     # a small "person" (20 x 40)
    img[500:540, 930:950] = 255     # its neighbour
    img[100:700, 100:900] = 255     # a big board
    return img


def test_small_boxes_are_zoomed_and_neighbours_share_a_crop() -> None:
    full, crops = bc.plan([[900, 500, 920, 540], [930, 500, 950, 540], [100, 100, 900, 700]], 1080, 1920, zoom=True)
    assert full == [2]
    assert len(crops) == 1 and sorted(crops[0].members) == [0, 1]
    # Every member still fills enough of the model's input.
    scale = bc.ENCODER_SIDE / crops[0].side
    assert 40 * scale >= bc.MIN_ENCODER_PX_IN_CROP


def test_without_zoom_everything_runs_on_the_full_image() -> None:
    full, crops = bc.plan([[900, 500, 920, 540], [100, 100, 900, 700]], 1080, 1920, zoom=False)
    assert full == [0, 1] and crops == []


def test_far_apart_small_boxes_get_their_own_crops() -> None:
    _, crops = bc.plan([[10, 10, 30, 50], [1800, 1000, 1820, 1040]], 1080, 1920, zoom=True)
    assert len(crops) == 2


def test_masks_are_clipped_to_their_box_and_mapped_back_from_the_crop() -> None:
    img = _scene()
    seg = _Seg()
    boxes = [[900, 500, 920, 540], [930, 500, 950, 540], [100, 100, 900, 700]]
    out = bc.convert(img, boxes, set_image=seg.set_image, predict_box=seg.predict_box, zoom=True)
    assert [r.zoomed for r in out] == [True, True, False]
    # One crop for the pair, then the full image for the board.
    assert len(seg.sets) == 2 and seg.sets[-1] == (1080, 1920)
    for r, (x1, y1, x2, y2) in zip(out, boxes, strict=True):
        xs = [p[0] for p in r.polygon]; ys = [p[1] for p in r.polygon]
        margin = bc.CLIP_MARGIN * max(x2 - x1, y2 - y1) + 3
        # Each polygon stays on its own object: the neighbour, though
        # bright in the same crop, is not taken in.
        assert x1 - margin <= min(xs) and max(xs) <= x2 + margin
        assert y1 - margin <= min(ys) and max(ys) <= y2 + margin
    # The crop's boxes were given to the predictor in crop pixels.
    assert all(b[0] < 900 for b in seg.boxes[:2])


def test_the_full_image_is_only_encoded_when_needed() -> None:
    img = _scene()
    seg = _Seg()
    bc.convert(img, [[900, 500, 920, 540]], set_image=seg.set_image, predict_box=seg.predict_box, zoom=True)
    assert seg.sets == [seg.sets[0]] and seg.sets[0] != (1080, 1920)
    seg2 = _Seg()
    bc.convert(img, [[900, 500, 920, 540]], set_image=seg2.set_image, predict_box=seg2.predict_box,
               zoom=True, keep_full=True)
    assert seg2.sets[-1] == (1080, 1920)


def test_an_empty_mask_gives_no_polygon() -> None:
    img = np.zeros((200, 300, 3), dtype=np.uint8)
    seg = _Seg()
    out = bc.convert(img, [[10, 10, 60, 60]], set_image=seg.set_image, predict_box=seg.predict_box, zoom=False)
    assert out == [None]


def _track_scene() -> tuple[np.ndarray, np.ndarray]:
    """A frame whose lower half is ground: tarmac and grass found by the
    text prompts, a painted logo and a kerb strip that are not."""
    h, w = 400, 600
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[300:330, 250:290] = 255  # a car on the ground (bright: the _Seg predictor finds it)
    material = np.zeros((h, w), dtype=np.uint8)
    material[200:400, :] = 1
    material[260:280, 100:160] = 0      # a painted logo: a hole in the material
    material[350:360, :] = 0            # a kerb right across the frame: a gap, not a hole
    return img, material


def test_ground_takes_the_material_fills_logos_and_kerbs_and_cuts_out_objects() -> None:
    img, material = _track_scene()
    seg = _Seg()
    asked: list[tuple[str, ...]] = []

    def text(prompts):
        asked.append(prompts)
        return material

    out = bc.convert(img, [[250, 300, 290, 330], [0, 200, 600, 400]], set_image=seg.set_image,
                     predict_box=seg.predict_box, text_masks=text, modes=["object", "ground"], zoom=False)
    g = out[1].mask
    assert out[1].polygon == [] and g is not None
    assert asked == [bc.GROUND_PROMPTS + bc.GROUND_EXTRA_PROMPTS, bc.GROUND_BLOCKER_PROMPTS]
    assert g[270, 130] == 1          # the painted logo is ground
    assert g[355, 50] == 1           # so is the kerb
    assert g[315, 270] == 0          # the car is cut out
    assert g[100, 300] == 0          # nothing above the ground box


def test_crowd_joins_people_and_falls_back_to_the_box() -> None:
    h, w = 300, 400
    img = np.zeros((h, w, 3), dtype=np.uint8)
    people = np.zeros((h, w), dtype=np.uint8)
    for x in (100, 113, 126, 139, 152):  # five people, 3 px apart
        people[100:160, x:x + 10] = 1
    seg = _Seg()
    out = bc.convert(img, [[90, 90, 170, 170]], set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=lambda p: people, modes=["crowd"], zoom=False)
    assert out[0].mask[130, 111] == 1  # joined across the gap
    # Without text prompts: the box, minus what else is labelled.
    out2 = bc.convert(img, [[90, 90, 140, 170]], set_image=seg.set_image, predict_box=seg.predict_box,
                      text_masks=None, modes=["crowd"], zoom=False)
    assert out2[0].mask[90:170, 90:140].all()


def test_a_faint_overlay_keeps_its_box() -> None:
    img = np.zeros((300, 400, 3), dtype=np.uint8)
    img[20:24, 300:304] = 255            # SAM would only find a speck
    seg = _Seg()
    out = bc.convert(img, [[280, 10, 380, 60]], set_image=seg.set_image, predict_box=seg.predict_box,
                     modes=["overlay"], zoom=False)
    assert out[0].polygon == [[280, 10], [380, 10], [380, 60], [280, 60]]


def test_a_crowd_of_fewer_than_five_is_not_joined() -> None:
    people = np.zeros((300, 400), dtype=np.uint8)
    people[100:160, 100:110] = 1
    people[100:160, 113:123] = 1
    m = bc.crowd_mask(people, [90, 90, 140, 170], np.zeros_like(people))
    assert m[130, 111] == 0 and m[130, 105] == 1


def test_ground_does_not_fill_over_a_tree_or_a_fence() -> None:
    material = np.zeros((200, 300), dtype=np.uint8)
    material[100:200, :] = 1
    material[140:160, 100:120] = 0          # an enclosed hole...
    blockers = np.zeros_like(material)
    blockers[140:160, 100:120] = 1          # ...that is a tree
    g = bc.ground_mask(material, [0, 100, 300, 200], np.zeros_like(material), blockers)
    assert g[150, 110] == 0 and g[180, 50] == 1


def test_a_translucent_overlay_cuts_nothing_out_of_the_ground() -> None:
    img = np.zeros((300, 400, 3), dtype=np.uint8)
    material = np.ones((300, 400), dtype=np.uint8)
    seg = _Seg()
    out = bc.convert(img, [[280, 200, 380, 260], [0, 0, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, text_masks=lambda p: material,
                     modes=["overlay", "ground"], zoom=False)
    assert out[0].translucent
    assert out[1].mask[230, 330] == 1      # the ground runs on under the watermark


def _seg_with(mask_full: np.ndarray):
    """A predictor whose mask for any box is ``mask_full`` (full image only)."""
    class P(_Seg):
        def predict_box(self, box):
            self.boxes.append([float(v) for v in box])
            return mask_full.copy(), 0.9
    return P()


def test_an_object_split_by_something_in_front_keeps_both_pieces_as_a_mask() -> None:
    m = np.zeros((200, 300), dtype=np.uint8)
    m[50:150, 20:120] = 1
    m[50:150, 140:240] = 1      # a pole between x 120 and 140
    seg = _seg_with(m)
    out = bc.convert(np.zeros((200, 300, 3), np.uint8), [[20, 50, 240, 150]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["object"], zoom=False)
    assert out[0].polygon == [] and out[0].mask is not None
    assert out[0].mask[100, 60] == 1 and out[0].mask[100, 200] == 1 and out[0].mask[100, 130] == 0


def test_an_opening_stays_open_for_an_object_and_is_filled_for_a_flat_carrier() -> None:
    m = np.zeros((200, 300), dtype=np.uint8)
    m[40:160, 40:260] = 1
    m[70:130, 100:200] = 0      # a big opening (or a logo split off a board)
    for mode, expect in (("object", 0), ("flat", 1)):
        seg = _seg_with(m)
        out = bc.convert(np.zeros((200, 300, 3), np.uint8), [[40, 40, 260, 160]], set_image=seg.set_image,
                         predict_box=seg.predict_box, modes=[mode], zoom=False)
        r = out[0]
        if r.mask is not None:
            assert r.mask[100, 150] == expect
        else:  # a flat board with its hole filled is one simple shape: a polygon
            assert expect == 1 and len(r.polygon) >= 4


def test_a_simple_object_is_still_an_editable_polygon() -> None:
    m = np.zeros((200, 300), dtype=np.uint8)
    m[50:150, 50:250] = 1
    seg = _seg_with(m)
    out = bc.convert(np.zeros((200, 300, 3), np.uint8), [[50, 50, 250, 150]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["object"], zoom=False)
    assert out[0].mask is None and len(out[0].polygon) >= 4


def test_a_see_through_carrier_is_cut_by_what_stands_in_front_not_by_what_is_behind() -> None:
    h, w = 300, 400
    goal = np.zeros((h, w), np.uint8)
    goal[100:200, 100:300] = 1   # the net's outline
    keeper = np.zeros((h, w), np.uint8)
    keeper[120:260, 180:220] = 1  # stands in front: feet below the goal line
    ball = np.zeros((h, w), np.uint8)
    ball[140:160, 120:140] = 1    # inside the net, behind it

    class P(_Seg):
        def predict_box(self, box):
            x1 = float(box[0])
            return ({100.0: goal, 180.0: keeper, 120.0: ball}[x1]).copy(), 0.9

    seg = P()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[100, 100, 300, 200], [180, 120, 220, 260], [120, 140, 140, 160]],
                     set_image=seg.set_image, predict_box=seg.predict_box,
                     modes=["carrier", "object", "object"], zoom=False)
    net = _raster(out[0], h, w)
    assert net[150, 200] == 0     # a hole where the keeper stands in front
    assert net[150, 130] == 1     # the ball behind shows through: the net is drawn over it


def test_ropes_keep_their_true_width_and_a_cage_fence_is_filled() -> None:
    h, w = 300, 400
    ropes = np.zeros((h, w), np.uint8)
    for y in (100, 150, 200):
        ropes[y:y + 4, 20:380] = 1           # three ropes, 4 px thick
    ropes[100:204, 20:26] = 1                # a corner post joins them
    seg = _seg_with(np.ones((h, w), np.uint8))   # the box prompt would take everything
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[10, 90, 390, 210]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["ropes"], zoom=False,
                     text_masks=lambda p: ropes if p == bc.ROPE_PROMPTS else np.zeros((h, w), np.uint8))
    m = _raster(out[0], h, w)
    assert m[101, 200] == 1 and m[125, 200] == 0   # a rope, and the gap below it stays open

    fence = np.zeros((h, w), np.uint8)
    fence[100:200, 20:380] = 1
    fence[140:160, 100:300] = 0              # mesh SAM did not take
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[10, 90, 390, 210]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["ropes"], zoom=False,
                     text_masks=lambda p: fence if p == bc.CAGE_PROMPTS else np.zeros((h, w), np.uint8))
    assert _raster(out[0], h, w)[150, 200] == 1   # the mesh is part of the cage


def test_a_net_is_found_by_name_not_by_a_loose_box() -> None:
    h, w = 300, 400
    floor = np.zeros((h, w), np.uint8)
    floor[100:250, 50:350] = 1               # what the box prompt takes: the floor around the net
    net = np.zeros((h, w), np.uint8)
    net[100:250, 195:205] = 1                # the net, seen edge-on
    seg = _seg_with(floor)
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[50, 100, 350, 250]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["net"], zoom=False, text_masks=lambda p: net)
    r = out[0]
    xs = [p[0] for p in r.polygon]
    assert r.mask is None and min(xs) >= 190 and max(xs) <= 210


def test_a_long_row_of_boards_is_masked_in_pieces() -> None:
    h, w = 200, 1600

    class P(_Seg):
        def predict_box(self, box):
            self.boxes.append([float(v) for v in box])
            # SAM given the whole row keeps one board of it; a piece gets its part.
            x1, x2 = int(box[0]), int(box[2])
            m = np.zeros((h, w), np.uint8)
            if x2 - x1 > 1000:
                m[80:120, 0:300] = 1
            else:
                m[80:120, x1:x2] = 1
            return m, 0.9

    seg = P()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[0, 80, 1600, 120]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["flat"], zoom=False)
    assert len(seg.boxes) > 1
    xs = [p[0] for p in out[0].polygon]
    assert out[0].mask is None and min(xs) <= 5 and max(xs) >= 1595


def test_the_ground_is_closed_across_a_net() -> None:
    h, w = 300, 400
    material = np.zeros((h, w), np.uint8)
    material[50:120, :] = 1                  # far court
    material[200:300, :] = 1                 # near court; the band between is seen through the net
    blockers = np.zeros_like(material)
    blockers[120:200, :] = 1                 # the mesh, taken for a fence
    through = np.zeros_like(material)
    through[118:202, 40:360] = 1             # the net
    g = bc.ground_mask(material, [0, 50, 400, 300], np.zeros_like(material), blockers, through)
    assert g[160, 200] == 1                  # behind the net: ground
    assert g[160, 10] == 0                   # beside it, a real fence: not ground


def test_touching_crowd_boxes_come_back_as_one_crowd() -> None:
    h, w = 300, 400
    people = np.zeros((h, w), np.uint8)
    for x in range(20, 380, 13):
        people[100:160, x:x + 10] = 1
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[10, 90, 200, 170], [195, 90, 390, 170]],
                     set_image=seg.set_image, predict_box=seg.predict_box, text_masks=lambda p: people,
                     modes=["crowd", "crowd"], zoom=False)
    keep, gone = (0, 1) if out[0].mask is not None else (1, 0)
    assert out[gone].merged_into == keep and out[gone].mask is None
    m = out[keep].mask
    assert m[130, 60] == 1 and m[130, 300] == 1 and m[130, 198] == 1   # one area, no seam


def test_in_front_compares_the_bottoms_in_the_same_columns() -> None:
    carrier = bc.Piece(0, 0, np.zeros((300, 400), np.uint8))
    carrier.m[50:100, 0:200] = 1             # a high pane on the left
    carrier.m[50:250, 200:400] = 1           # a pane down to the floor on the right
    ref = bc.Piece(250, 150, np.ones((80, 20), np.uint8))   # feet at 229, right side: behind
    assert not bc._in_front(ref, carrier)
    near = bc.Piece(100, 100, np.ones((60, 20), np.uint8))  # feet at 159, left side: in front
    assert bc._in_front(near, carrier)
