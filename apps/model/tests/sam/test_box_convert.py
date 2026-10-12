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


def _only(prompts: tuple[str, ...], mask: np.ndarray):
    """Text prompts that find ``mask`` for ``prompts`` and nothing else."""
    return lambda p: mask if p == prompts else np.zeros_like(mask)


def _people(mask: np.ndarray):
    """Text prompts that find ``mask`` as people one by one, and nothing
    else."""
    return _only(bc.CROWD_PERSON_PROMPTS, mask)


def _surfaces(found: dict[str, np.ndarray], like: np.ndarray):
    """Text prompts that find ``found[prompt]`` for each ground prompt asked
    alone, and nothing for anything else."""
    return lambda p: found.get(p[0], np.zeros_like(like)) if len(p) == 1 else np.zeros_like(like)


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
    assert asked == [(p,) for p in bc.GROUND_PROMPTS] + [bc.GROUND_EXTRA_PROMPTS, bc.WATER_PROMPTS, bc.GROUND_BLOCKER_PROMPTS]
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
                     text_masks=_people(people), modes=["crowd"], zoom=False)
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
                     set_image=seg.set_image, predict_box=seg.predict_box, text_masks=_people(people),
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


def test_water_is_ground_only_where_it_is_most_of_the_box() -> None:
    h, w = 300, 400
    road = np.zeros((h, w), np.uint8)
    road[150:300, :] = 1                     # a street circuit...
    harbour = np.zeros((h, w), np.uint8)
    harbour[0:100, :] = 1                    # ...with a harbour beside it
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[0, 0, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["ground"], zoom=False,
                     text_masks=lambda p: harbour if p == bc.WATER_PROMPTS
                     else (road if p[0] == bc.GROUND_PROMPTS[0] else np.zeros((h, w), np.uint8)))
    g = out[0].mask
    assert g[200, 200] == 1 and g[50, 200] == 0

    pool = np.zeros((h, w), np.uint8)
    pool[20:280, 20:380] = 1                 # a pool: the water is the field of play
    deck = np.zeros((h, w), np.uint8)
    deck[0:20, :] = 1
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[0, 0, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["ground"], zoom=False,
                     text_masks=lambda p: pool if p == bc.WATER_PROMPTS
                     else (deck if p[0] == bc.GROUND_PROMPTS[0] else np.zeros((h, w), np.uint8)))
    assert out[0].mask[150, 200] == 1
    assert out[0].mask[10, 200] == 0         # the water alone: not the deck (nor a jetty, a shore)


def test_competitors_inside_a_crowd_box_are_not_crowd() -> None:
    h, w = 300, 400
    people = np.zeros((h, w), np.uint8)
    for x in (100, 113, 126, 139, 152):      # spectators along a barrier
        people[60:120, x:x + 10] = 1
    rider = np.zeros((h, w), np.uint8)
    rider[180:240, 200:215] = 1              # a rider on the road, inside the box rectangle
    found = {bc.CROWD_PERSON_PROMPTS: people | rider, bc.ATHLETE_PROMPTS: rider}
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[90, 50, 260, 250]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["crowd"], zoom=False,
                     text_masks=lambda p: found.get(p, np.zeros((h, w), np.uint8)))
    m = out[0].mask
    assert m[90, 105] == 1 and m[90, 111] == 1   # the spectators, joined
    assert not m[175:245, 195:220].any()         # the rider is not


class _ByBox(_Seg):
    """A predictor with a mask of its own for each box."""

    def __init__(self, masks: dict[tuple[int, ...], np.ndarray]) -> None:
        super().__init__()
        self.masks = masks

    def predict_box(self, box):
        self.boxes.append([float(v) for v in box])
        return self.masks[tuple(int(round(v)) for v in box)].copy(), 0.9


def test_what_is_labelled_inside_a_design_element_is_cut_out_of_it() -> None:
    h, w = 300, 400
    tile = np.zeros((h, w), np.uint8)
    tile[100:250, 100:300] = 1               # a photo tile, a design element
    car = np.zeros((h, w), np.uint8)
    car[150:180, 150:210] = 1                # a car shown in it
    scene = np.zeros((h, w), np.uint8)
    scene[200:290, 280:330] = 1              # a person in the scene, partly behind the tile
    seg = _ByBox({(100, 100, 300, 250): tile, (148, 148, 212, 182): car, (280, 200, 330, 290): scene})
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[100, 100, 300, 250], [148, 148, 212, 182], [280, 200, 330, 290]],
                     set_image=seg.set_image, predict_box=seg.predict_box,
                     modes=["overlay", "object", "object"], zoom=False)
    o = _raster(out[0], h, w)
    assert o[165, 180] == 0                  # the car is cut out of the tile
    assert o[120, 120] == 1 and o[230, 290] == 1   # the rest of the tile stays, under the scene person too


def test_a_ground_inside_a_design_element_is_not_blocked_by_it() -> None:
    h, w = 300, 400
    tile = np.zeros((h, w), np.uint8)
    tile[100:250, 100:300] = 1               # a photo tile
    bug = np.zeros((h, w), np.uint8)
    bug[10:40, 10:80] = 1                    # a score bug over the main scene
    material = np.zeros((h, w), np.uint8)
    material[:, :] = 1
    seg = _ByBox({(100, 100, 300, 250): tile, (10, 10, 80, 40): bug})
    out = bc.convert(np.zeros((h, w, 3), np.uint8),
                     [[100, 100, 300, 250], [10, 10, 80, 40], [110, 180, 290, 245], [0, 0, 400, 90]],
                     set_image=seg.set_image, predict_box=seg.predict_box, text_masks=_surfaces({"road": material}, material),
                     modes=["overlay", "overlay", "ground", "ground"], zoom=False)
    inset_ground, main_ground = out[2].mask, out[3].mask
    assert inset_ground[200, 200] == 1           # the track in the tile is ground...
    assert _raster(out[0], h, w)[200, 200] == 0  # ...and not the tile
    assert _raster(out[0], h, w)[120, 200] == 1
    assert main_ground[25, 40] == 0 and main_ground[60, 200] == 1   # the score bug still blocks the main ground


def test_a_barrier_at_an_angle_across_its_long_box_keeps_sams_whole_mask() -> None:
    h, w = 300, 1600
    wall = np.zeros((h, w), np.uint8)
    for x in range(100, 1500):               # a thin wall running down across its box
        y = 100 + (x - 100) * 120 // 1400
        wall[y:y + 8, x] = 1

    class P(_Seg):
        def predict_box(self, box):
            self.boxes.append([float(v) for v in box])
            if box[2] - box[0] > 1000:
                return wall.copy(), 0.9        # the whole box: the wall
            m = np.zeros((h, w), np.uint8)     # a piece's square: mostly the track beside it
            m[int(box[1]):int(box[3]), int(box[0]):int(box[2])] = 1
            return m, 0.5

    seg = P()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[100, 100, 1500, 230]], set_image=seg.set_image,
                     predict_box=seg.predict_box, modes=["flat"], zoom=False)
    m = _raster(out[0], h, w)
    assert len(seg.boxes) > 1
    assert m[103, 110] == 1 and m[221, 1490] == 1    # the wall, end to end
    assert m[200, 300] == 0                          # not the track below it


def test_the_ground_is_the_course_not_the_field_beside_an_open_road() -> None:
    h, w = 300, 400
    road = np.zeros((h, w), np.uint8)
    road[:, 0:180] = 1                       # the road the riders are on
    road[:, 320:400] = 1                     # more of it beyond a hedge, no one on it
    field = np.zeros((h, w), np.uint8)
    field[:, 200:300] = 1                    # a field beside it...
    field[297:300, 180:200] = 1              # ...touching the road only along the frame edge
    trees = np.zeros((h, w), np.uint8)
    trees[:297, 180:200] = 1
    trees[:, 300:320] = 1
    zero = np.zeros((h, w), np.uint8)

    def text(p):
        if p == bc.GROUND_BLOCKER_PROMPTS:
            return trees
        return {"road": road, "dirt": field}.get(p[0], zero) if len(p) == 1 else zero

    riders = [[40, 60, 60, 120], [90, 120, 110, 180], [130, 180, 150, 240]]
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), riders + [[0, 0, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, text_masks=text, modes=["object"] * 3 + ["ground"], zoom=False)
    g = out[3].mask
    assert g[150, 100] == 1 and g[290, 100] == 1     # the road
    assert g[150, 250] == 0                          # not the field
    assert g[150, 360] == 1                          # the same road beyond the hedge is


def test_a_ground_box_drawn_short_of_the_frame_edge_is_taken_to_it() -> None:
    h, w = 300, 400
    grass = np.zeros((h, w), np.uint8)
    grass[100:, :] = 1                       # the grass fills the frame's lower part
    seg = _Seg()
    # The box stops 30 px short of the left edge (a vision model's box).
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[30, 100, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, text_masks=_surfaces({"grass": grass}, grass),
                     modes=["ground"], zoom=False)
    g = out[0].mask
    assert g[200, 200] == 1
    assert g[200, 10] == 1                   # no straight cut along the box's side
    assert g[250, 0] == 1


def test_a_ground_box_ending_where_the_ground_ends_is_not_widened() -> None:
    h, w = 300, 400
    grass = np.zeros((h, w), np.uint8)
    grass[100:, :] = 1
    grass[:, 30:45] = 0                      # a fence just inside the box's side...
    fence = np.zeros((h, w), np.uint8)
    fence[100:, 30:45] = 1
    zero = np.zeros((h, w), np.uint8)

    def text(p):
        if p == bc.GROUND_BLOCKER_PROMPTS:
            return fence
        return grass if p == ("grass",) else zero

    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), [[30, 100, 400, 300]], set_image=seg.set_image,
                     predict_box=seg.predict_box, text_masks=text, modes=["ground"], zoom=False)
    g = out[0].mask
    assert g[200, 200] == 1
    assert g[200, 10] == 0                   # ...and the grass beyond it is not the ground


def _stand_people(h: int, w: int, rows: list[tuple[int, int]]) -> np.ndarray:
    people = np.zeros((h, w), np.uint8)
    for y0, y1 in rows:
        for x in range(20, 590, 13):
            people[y0:y1, x:x + 10] = 1
    return people


def test_crowd_boxes_across_a_narrow_gap_are_one_stand_with_its_people() -> None:
    h, w = 400, 1000                          # a 20 px gap at most (2% of 1000)
    people = _stand_people(h, w, [(60, 350)])  # one packed stand, gap included
    boxes = [[10, 50, 600, 200], [10, 215, 600, 360]]   # 15 px apart
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=_people(people), modes=["crowd", "crowd"], zoom=False)
    keep, gone = (0, 1) if out[0].mask is not None else (1, 0)
    assert out[gone].merged_into == keep
    m = out[keep].mask
    assert m[100, 25] == 1 and m[300, 25] == 1
    assert m[207, 25] == 1                    # the spectators in the gap are crowd


def test_crowd_boxes_far_apart_stay_apart() -> None:
    h, w = 400, 1000
    people = _stand_people(h, w, [(60, 350)])
    boxes = [[10, 50, 600, 180], [10, 220, 600, 360]]   # 40 px apart: two sections
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=_people(people), modes=["crowd", "crowd"], zoom=False)
    assert out[0].mask is not None and out[1].mask is not None
    assert out[0].mask[200, 25] == 0 and out[1].mask[200, 25] == 0


def test_an_empty_gap_between_crowd_boxes_is_not_filled() -> None:
    h, w = 400, 1000
    people = _stand_people(h, w, [(60, 195), (220, 350)])   # stairs between the boxes
    boxes = [[10, 50, 600, 200], [10, 215, 600, 360]]
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=_people(people), modes=["crowd", "crowd"], zoom=False)
    keep = 0 if out[0].mask is not None else 1
    assert out[keep].mask[207, 25] == 0       # one stand, but nobody there is painted


def test_stands_join_only_boxes_side_by_side_on_the_same_side_of_an_inset() -> None:
    boxes = [[0, 0, 100, 100], [110, 0, 200, 100], [210, 110, 300, 200], [110, 105, 200, 200]]
    # 0 and 1 side by side (10 px); 2 only diagonal to 1; 3 below 1 but in an inset.
    groups = bc._stands(boxes, [0, 1, 2, 3], 20.0, lambda i: "inset" if i == 3 else "", lambda g: True)
    by_box = {i: (sorted(g), gaps) for g, gaps in groups for i in g}
    assert by_box[0][0] == [0, 1] and by_box[0][1] == [[100, 0, 110, 100]]
    assert by_box[2][0] == [2] and by_box[3][0] == [3]


def test_a_gap_under_a_graphic_does_not_join_two_stands() -> None:
    boxes = [[0, 0, 100, 100], [110, 0, 200, 100]]
    graphic = [95, 20, 130, 60]
    groups = bc._stands(boxes, [0, 1], 20.0, lambda i: "", lambda g: not bc._meet(g, graphic))
    assert sorted(sorted(g) for g, _ in groups) == [[0], [1]]


def test_a_packed_stand_does_not_close_over_an_empty_gap() -> None:
    # Packed spectators (wide blobs, a big closing) on both sides of an
    # empty staircase 15 px wide between two crowd boxes.
    h, w = 400, 1000
    people = np.zeros((h, w), np.uint8)
    for x in range(20, 590, 50):
        people[60:200, x:x + 46] = 1          # up to the boxes' edges: the staircase
        people[215:350, x:x + 46] = 1         # is narrower than the closing
    boxes = [[10, 50, 600, 200], [10, 215, 600, 360]]
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=_people(people), modes=["crowd", "crowd"], zoom=False)
    keep = 0 if out[0].mask is not None else 1
    m = out[keep].mask
    assert m[100, 50] == 1 and m[300, 50] == 1
    assert not m[200:215, 20:590].any()       # the staircase stays empty


def test_only_the_people_in_a_gap_are_crowd_not_the_stairs_beside_them() -> None:
    h, w = 400, 1000
    people = np.zeros((h, w), np.uint8)
    for x in range(20, 590, 50):
        people[60:200, x:x + 46] = 1
        people[215:350, x:x + 46] = 1
    people[200:215, 20:66] = 1                # a spectator sitting on the stairs
    boxes = [[10, 50, 600, 200], [10, 215, 600, 360]]
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=_people(people), modes=["crowd", "crowd"], zoom=False)
    keep = 0 if out[0].mask is not None else 1
    m = out[keep].mask
    assert m[207, 40] == 1                    # the spectator is crowd
    assert not m[200:215, 75:590].any()       # the stairs beside them are not


def test_a_crowd_area_found_as_a_whole_is_not_taken_into_a_gap() -> None:
    # "crowd" finds the stand as one blob, stairs included; in the gap
    # only the people found one by one count.
    h, w = 400, 1000
    one_by_one = _stand_people(h, w, [(60, 200), (215, 350)])
    blob = np.zeros((h, w), np.uint8)
    blob[55:355, 15:595] = 1
    zero = np.zeros((h, w), np.uint8)

    def text(p):
        return {bc.CROWD_PERSON_PROMPTS: one_by_one, bc.CROWD_AREA_PROMPTS: blob}.get(p, zero)

    boxes = [[10, 50, 600, 200], [10, 215, 600, 360]]
    seg = _Seg()
    out = bc.convert(np.zeros((h, w, 3), np.uint8), boxes, set_image=seg.set_image, predict_box=seg.predict_box,
                     text_masks=text, modes=["crowd", "crowd"], zoom=False)
    keep = 0 if out[0].mask is not None else 1
    m = out[keep].mask
    assert m[100, 25] == 1 and m[300, 25] == 1
    assert not m[200:215].any()               # the blob alone fills nothing in the gap
