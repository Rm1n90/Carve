"""Boxes -> polygons for one image, in one call.

Two things decide the quality of a mask made from a box:

* **One mask, not three.** A box is not an ambiguous prompt, and SAM's
  single-mask output is the one trained for it. Asking for three
  candidates and keeping the highest score regularly returns the
  biggest one: a wheel's mask takes the car body with it, a person's
  takes the neighbours.
* **Resolution.** SAM sees the image resized to about 1000 px on its
  long side. A 40 px person in a 1920 px frame is 20 px to the model,
  and the mask comes back as a blob. Small boxes are therefore cut out
  with some context and encoded on their own, so the object fills the
  model's input. Boxes close together share one crop, so a crowd costs a
  few extra encodes, not one per person.

Each mask is then clipped to its box (plus a small margin), so a mask
cannot run into the next object, and cleaned before it is traced.

Two kinds of box are not one object, and SAM given such a box cuts out
the single most object-like thing in it (on a race track, one kerb):

* **ground** (the playing surface): every ground-material pixel inside
  the box, found with SAM 3.1 text prompts (road, grass, gravel, ...;
  water only where it is most of the box, so a harbour beside a street
  circuit is not ground but a pool is).
  Holes and short gaps no other label claims are filled, so painted
  logos, lines and kerbs stay part of it, and everything else labelled
  on the image (cars, boards, people) is cut out.
* **crowd**: the people SAM 3.1 finds with the prompt "person" inside
  the box, joined across the small gaps between them.

Both come back as pixel masks (they have holes and several parts). An
**overlay** box (a broadcast graphic) keeps SAM's outline when SAM finds
the graphic, and falls back to the box for a faint, see-through bug
where SAM only finds a blob of the scene behind it.

The other boxes differ in what their holes mean:

* **object**: holes can be real openings (a bicycle frame, an arch) and
  an object split by something in front of it is one object in several
  pieces. Both are kept, so such a shape comes back as a pixel mask; a
  simple shape (one piece, no hole) comes back as an editable polygon.
* **flat** printed carriers (boards, banners, screens, tables, hulls,
  sails): a hole is print the segmenter split off its surface, so holes
  are filled; pieces are kept.
* **carrier**, see-through glass: the shape is the full outline of the
  pane. What stands in front of it cuts a hole in it; what is behind
  shows through and keeps its own label, and the ground is not cut by it.
* **net** (goals, nets, backboards): the same, but the outline is taken
  from what SAM 3.1 finds by name ("net", "goal", ...) inside the box. A
  box prompt on a loose box around a net seen edge-on takes the floor
  around it.
* **ropes** (ring ropes, a fighting cage): the ropes and rails SAM 3.1
  finds by name, at their true width, and a cage's fence, filled. Never
  an outline over the whole ring.

The ground and a crowd are seen through glass, nets and ropes: they are
closed across them.

A flat box much longer than high (a row of boards along a pitch) is also
masked in overlapping pieces, and the pieces are joined: SAM given the
whole row keeps one board of it. Crowd boxes that touch are one stand
section: they are masked as one area and come back as one crowd (the
largest box's); the others are marked as merged into it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import cv2
import numpy as np

from carve_model.sam.polygonize import DEFAULT_EPSILON_FACTOR, cleanup_mask, mask_to_polygon

# The model's input side; boxes are judged by their size at this scale.
ENCODER_SIDE = 1008
# A box whose long side is under this many encoder pixels is zoomed.
ZOOM_BELOW_ENCODER_PX = 160
# The crop around a zoomed box: its long side times this, at least this
# many image pixels.
CROP_CONTEXT = 2.2
CROP_MIN_PX = 96
# Boxes share a crop only while every box in it still spans at least
# this many pixels of the model's input.
MIN_ENCODER_PX_IN_CROP = 160
# Masks may extend this far past their box (fraction of the box's long
# side, plus a couple of pixels for the edge).
CLIP_MARGIN = 0.06
# Below this short side (image pixels) the morphological clean-up is
# skipped: on small masks it eats real detail.
CLEANUP_MIN_SIDE = 40

MODES = ("object", "flat", "carrier", "net", "ropes", "ground", "crowd", "overlay")
# Modes whose shape comes from SAM's box prompt.
BOX_MODES = ("object", "flat", "carrier", "net", "ropes", "overlay")
# See-through: they hide neither the ground nor a crowd.
SEE_THROUGH = ("carrier", "net", "ropes")
# A piece of a shape smaller than this share of it (or 16 px) is noise.
PART_MIN = 0.05
# A hole smaller than this share of an object (or 16 px) is noise.
HOLE_MIN = 0.01
# Prompts whose union is the ground, across the sports in the data set.
GROUND_PROMPTS = (
    "road", "race track", "asphalt", "grass", "gravel", "sand", "dirt",
    "sports field", "court floor", "running track", "ice", "snow",
    # The flat floor of a skate plaza, without its stairs, ledges and
    # ramps (not labelled). "concrete" or "skatepark" alone would take
    # those, and pavements beside a street circuit.
    "skate park floor",
)
# Water is ground only where it is most of the ground box: a pool, a
# regatta, a surf break. Beside a road or a pitch (a harbour along a
# street circuit, a river) it is scenery.
WATER_PROMPTS = ("water",)
CROWD_PROMPTS = ("person", "crowd")
# Ground also takes these (a kerb or logo running to the frame edge is
# not a hole, so filling alone would miss it).
GROUND_EXTRA_PROMPTS = ("kerb", "painted marking on the ground")
# Never filled into the ground, though enclosed by it.
GROUND_BLOCKER_PROMPTS = ("person", "animal", "tree", "plant", "rock", "building", "wall", "fence", "pole", "sky")
# Context around a crowd box when it is encoded on its own (fraction of
# its size): distant spectators are found far better at that zoom.
CROWD_CROP_MARGIN = 0.1
# Gaps in the ground shorter than this share of the box's side are filled
# (a kerb or line running across the whole frame is not a "hole").
GROUND_GAP = 0.08
# An overlay's SAM outline is kept only when it covers at least this much
# of its box; otherwise the box is the mask.
OVERLAY_MIN_FILL = 0.5
# Nets, goals and backboards, found by name.
NET_PROMPTS = ("net", "goal", "basketball backboard")
# Ring ropes by name; a fighting cage (no ropes) by its fence.
ROPE_PROMPTS = ("rope", "boxing ring ropes")
CAGE_PROMPTS = ("fence",)
# A flat box at least this many times longer than high is also masked in
# overlapping pieces, each this many short sides long, one every
# LONG_STRIDE short sides, at most about LONG_MAX_PIECES of them.
LONG_RATIO = 4.0
LONG_PIECE = 2.0
LONG_STRIDE = 1.5
LONG_MAX_PIECES = 16
# Crowd boxes closer than this (pixels) are one area.
CROWD_TOUCH_PX = 4


@dataclass
class Crop:
    x0: int
    y0: int
    x1: int
    y1: int
    members: list[int] = field(default_factory=list)
    # The largest side this crop may grow to and keep every member zoomed.
    limit: float = 0.0

    @property
    def side(self) -> int:
        return max(self.x1 - self.x0, self.y1 - self.y0)


@dataclass
class BoxResult:
    polygon: list[list[float]]
    score: float
    zoomed: bool
    # Ground and crowd: the full-image mask (holes and parts kept).
    mask: np.ndarray | None = None
    # A translucent overlay (its box): it overlaps what shows through it
    # and cuts nothing out of the ground or a crowd.
    translucent: bool = False
    # A crowd box joined to the touching crowd box at this index, which
    # carries the mask of both: this one is no longer needed.
    merged_into: int | None = None


def _window(box: list[float], h: int, w: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    side = max(max(x2 - x1, y2 - y1) * CROP_CONTEXT, CROP_MIN_PX)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    return x0, y0, int(min(w, x0 + side)), int(min(h, y0 + side))


def plan(boxes: list[list[float]], h: int, w: int, *, zoom: bool) -> tuple[list[int], list[Crop]]:
    """Split the boxes into those decoded on the full image and crops
    (each with the boxes it serves)."""
    scale = ENCODER_SIDE / max(h, w)
    full: list[int] = []
    crops: list[Crop] = []
    order = sorted(range(len(boxes)), key=lambda i: -(boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]))
    for i in order:
        x1, y1, x2, y2 = boxes[i]
        if not zoom or max(x2 - x1, y2 - y1) * scale >= ZOOM_BELOW_ENCODER_PX:
            full.append(i)
            continue
        wx0, wy0, wx1, wy1 = _window(boxes[i], h, w)
        own = max(wx1 - wx0, wy1 - wy0)
        limit = max(own, max(x2 - x1, y2 - y1) * ENCODER_SIDE / MIN_ENCODER_PX_IN_CROP)
        for c in crops:
            ux0, uy0, ux1, uy1 = min(c.x0, wx0), min(c.y0, wy0), max(c.x1, wx1), max(c.y1, wy1)
            if max(ux1 - ux0, uy1 - uy0) <= min(c.limit, limit):
                c.x0, c.y0, c.x1, c.y1 = ux0, uy0, ux1, uy1
                c.members.append(i)
                c.limit = min(c.limit, limit)
                break
        else:
            crops.append(Crop(wx0, wy0, wx1, wy1, [i], limit))
    return sorted(full), crops


@dataclass
class Piece:
    """A shaped box's mask, held as the window of the image it lies in."""

    x0: int
    y0: int
    m: np.ndarray  # uint8, the window's pixels

    @property
    def bottom(self) -> int:
        ys = np.flatnonzero(self.m.any(axis=1))
        return self.y0 + int(ys[-1]) if ys.size else self.y0

    def paste(self, into: np.ndarray, value: int = 1) -> None:
        h, w = self.m.shape
        into[self.y0 : self.y0 + h, self.x0 : self.x0 + w][self.m > 0] = value


def _clip(mask: np.ndarray, box: list[float], offset: tuple[int, int]) -> Piece | None:
    """The mask, clipped to its box plus a margin. ``mask`` covers the
    image region starting at ``offset``; the box is in image pixels."""
    ox, oy = offset
    mh, mw = mask.shape
    x1, y1, x2, y2 = box
    margin = CLIP_MARGIN * max(x2 - x1, y2 - y1) + 2
    cx0, cy0 = int(max(ox, np.floor(x1 - margin))), int(max(oy, np.floor(y1 - margin)))
    cx1, cy1 = int(min(ox + mw, np.ceil(x2 + margin))), int(min(oy + mh, np.ceil(y2 + margin)))
    if cx1 <= cx0 or cy1 <= cy0:
        return None
    window = (mask[cy0 - oy : cy1 - oy, cx0 - ox : cx1 - ox] > 0).astype(np.uint8)
    return Piece(cx0, cy0, window) if window.any() else None


def _clean(piece: Piece, box: list[float], mode: str) -> Piece | None:
    """De-spike, drop noise pieces and holes, fill holes where the mode
    says a hole is print, not an opening."""
    m = piece.m
    if min(box[2] - box[0], box[3] - box[1]) >= CLEANUP_MIN_SIDE:
        k = np.ones((3, 3), np.uint8)
        m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)
    total = int(m.sum())
    if total == 0:
        return None
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, a in enumerate(areas) if a >= max(16, PART_MIN * total)] or [int(np.argmax(areas)) + 1]
    m = np.isin(labels, keep).astype(np.uint8)
    filled = _fill_holes(m)
    if mode in ("flat", "overlay", "carrier", "net"):
        m = filled
    else:
        holes = filled - m
        if holes.any():
            hn, hl, hs, _ = cv2.connectedComponentsWithStats(holes, connectivity=4)
            small = [i for i in range(1, hn) if hs[i, cv2.CC_STAT_AREA] < max(16, HOLE_MIN * total)]
            m = m | np.isin(hl, small).astype(np.uint8)
    return Piece(piece.x0, piece.y0, m)


def _is_simple(piece: Piece) -> bool:
    """One piece and no hole: a polygon says it all."""
    m = piece.m
    return cv2.connectedComponents(m, connectivity=8)[0] - 1 == 1 and not (_fill_holes(m) - m).any()


def _polygon(piece: Piece, epsilon_factor: float | None) -> list[list[float]]:
    padded = np.pad(piece.m, 1)
    poly = mask_to_polygon(
        padded, epsilon_factor=epsilon_factor or DEFAULT_EPSILON_FACTOR, cleanup_kernel=0
    )
    return [[px + piece.x0 - 1, py + piece.y0 - 1] for px, py in poly]


def _hull(piece: Piece) -> Piece:
    """The filled outline of a see-through carrier: the convex hull of
    everything SAM found of it (frame, posts, net or pane edges)."""
    pts = cv2.findNonZero(piece.m)
    out = np.zeros_like(piece.m)
    if pts is not None:
        cv2.fillPoly(out, [cv2.convexHull(pts)], 1)
    return Piece(piece.x0, piece.y0, out)


def _strands(piece: Piece) -> Piece | None:
    """Ropes as found: no smoothing (it would erase a far rope a few
    pixels thick), no filling (the gaps between ropes are not rope), only
    specks dropped."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(piece.m, connectivity=8)
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 16]
    if not keep:
        return None
    return Piece(piece.x0, piece.y0, np.isin(labels, keep).astype(np.uint8))


def _long_pieces(box: list[float]) -> list[list[float]]:
    """Overlapping pieces along a long flat box; none for a compact one."""
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    short, length = min(bw, bh), max(bw, bh)
    if short <= 0 or length < LONG_RATIO * short:
        return []
    piece = max(LONG_PIECE * short, length / LONG_MAX_PIECES * LONG_PIECE / LONG_STRIDE)
    stride = piece * LONG_STRIDE / LONG_PIECE
    starts = [float(v) for v in np.arange(0, length - piece, stride)] + [length - piece]
    if bw >= bh:
        return [[x1 + a, y1, x1 + a + piece, y2] for a in starts]
    return [[x1, y1 + a, x2, y1 + a + piece] for a in starts]


def _in_front(other: Piece, carrier: Piece) -> bool:
    """``other`` stands in front of a see-through carrier when its lowest
    pixel is below the carrier's lowest pixel in the same columns."""
    oc = other.x0 + np.flatnonzero(other.m.any(axis=0))
    cm = carrier.m
    cols = np.flatnonzero(cm.any(axis=0))
    if oc.size == 0 or cols.size == 0:
        return False
    bottoms = carrier.y0 + cm.shape[0] - 1 - np.argmax(cm[::-1, cols], axis=0)
    shared = np.isin(carrier.x0 + cols, oc)
    return bool(shared.any()) and other.bottom > int(bottoms[shared].max())


def _fill_across(m: np.ndarray, through: np.ndarray) -> np.ndarray:
    """A region seen through a net, glass or ropes is closed across them:
    the carrier's pixels between region pixels above and below, in the
    same column, join the region."""
    cand = ((through > 0) & (m == 0)).T.astype(np.int8)
    if not cand.any():
        return m
    w, h = cand.shape
    d = np.diff(np.pad(cand, ((0, 0), (1, 1))), axis=1)
    sc, sr = np.nonzero(d == 1)    # run starts (column, row)
    ec, er = np.nonzero(d == -1)   # run ends, exclusive
    mt = m.T
    ok = (sr > 0) & (er < h)
    ok[ok] = (mt[sc[ok], sr[ok] - 1] > 0) & (mt[ec[ok], er[ok]] > 0)
    if not ok.any():
        return m
    delta = np.zeros((w, h + 1), dtype=np.int32)
    np.add.at(delta, (sc[ok], sr[ok]), 1)
    np.add.at(delta, (ec[ok], er[ok]), -1)
    out = m.copy()
    out[(np.cumsum(delta, axis=1)[:, :h] > 0).T] = 1
    # Columns the run test missed (a speck of something else at a rope's
    # edge) are closed sideways, inside the carrier only.
    side = cv2.morphologyEx(out, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1)))
    out |= side & (through > 0).astype(np.uint8)
    return out


def _box_polygon(box: list[float]) -> list[list[float]]:
    x1, y1, x2, y2 = box
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def _overlay_check(poly: list[list[float]], box: list[float]) -> tuple[list[list[float]], bool]:
    """Keep SAM's outline for an overlay only when it found the graphic;
    otherwise the box, as a translucent overlay."""
    x1, y1, x2, y2 = box
    area = max(1.0, (x2 - x1) * (y2 - y1))
    if len(poly) < 3:
        return _box_polygon(box), True
    covered = cv2.contourArea(np.asarray(poly, dtype=np.float32)) / area
    return (poly, False) if covered >= OVERLAY_MIN_FILL else (_box_polygon(box), True)


def _claim(claimed: np.ndarray, poly: list[list[float]]) -> None:
    if len(poly) >= 3:
        cv2.fillPoly(claimed, [np.round(np.asarray(poly)).astype(np.int32)], 1)


def _box_mask(box: list[float], h: int, w: int) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.uint8)
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    m[max(0, y1) : min(h, y2), max(0, x1) : min(w, x2)] = 1
    return m


def _fill_holes(m: np.ndarray) -> np.ndarray:
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m)
    cv2.drawContours(out, cnts, -1, 1, thickness=cv2.FILLED)
    return out


def ground_mask(
    material: np.ndarray,
    box: list[float],
    claimed: np.ndarray,
    blockers: np.ndarray | None = None,
    through: np.ndarray | None = None,
) -> np.ndarray:
    """Ground-material pixels inside the box (kerbs and painted markings
    included), holes and short gaps filled (painted logos, lines, kerbs),
    except where something that is not ground stands (``blockers``:
    people, trees, buildings, walls, fences, poles, sky), closed across
    see-through carriers (``through``), minus everything else labelled."""
    h, w = material.shape
    inside = _box_mask(box, h, w)
    base = (material > 0).astype(np.uint8) & inside
    g = base
    if g.any():
        g = cv2.morphologyEx(g, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        gap = max(9, int(GROUND_GAP * min(box[2] - box[0], box[3] - box[1])))
        g = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap)))
        g = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (gap, 1)))
        g = _fill_holes(g) & inside
        if blockers is not None:
            # Filled pixels that are something else are given back; a net
            # or a glass wall is not, the ground is seen through it.
            b = (blockers > 0).astype(np.uint8)
            if through is not None:
                b &= 1 - (through > 0).astype(np.uint8)
            g &= 1 - (b & (1 - base))
        if through is not None:
            g = _fill_across(g, through & inside)
    return g & (1 - claimed)


def _with_water(land: np.ndarray, water: np.ndarray, box: list[float]) -> np.ndarray:
    """The ground material for one box: the land, plus the water when the
    water is most of what the box holds."""
    h, w = land.shape
    inside = _box_mask(box, h, w).astype(bool)
    land = (land > 0).astype(np.uint8)
    wet = (water > 0).astype(np.uint8)
    return land | wet if int(wet[inside].sum()) > int(land[inside].sum()) else land


def crowd_mask(
    people: np.ndarray,
    boxes: list[float] | list[list[float]],
    claimed: np.ndarray,
    through: np.ndarray | None = None,
) -> np.ndarray:
    """People inside the box (or the touching boxes, as one area) joined
    across small gaps and across ropes and nets, minus anything else
    labelled; the boxes themselves when no person is found."""
    h, w = people.shape
    if np.ndim(boxes) == 1:
        boxes = [boxes]  # type: ignore[list-item]
    inside = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        inside |= _box_mask(b, h, w)  # type: ignore[arg-type]
    c = (people > 0).astype(np.uint8) & inside
    if not c.any():
        return inside & (1 - claimed)
    # With five or more people, join the gaps narrower than half their
    # typical width, so a packed stand closes into one area whatever the
    # camera distance.
    n, _, stats, _ = cv2.connectedComponentsWithStats(c, connectivity=8)
    if n - 1 >= 5:
        k = max(3, int(np.median(stats[1:, cv2.CC_STAT_WIDTH]) / 2)) | 1
        c = cv2.morphologyEx(c, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8)) & inside
    if through is not None:
        c = _fill_across(c, through & inside)
    return c & (1 - claimed)


def _touching(boxes: list[list[float]], idx: list[int]) -> list[list[int]]:
    """``idx`` grouped by boxes that overlap or touch."""
    groups: list[list[int]] = []
    for i in idx:
        x1, y1, x2, y2 = boxes[i]
        near = [g for g in groups if any(
            x1 <= boxes[j][2] + CROWD_TOUCH_PX and boxes[j][0] <= x2 + CROWD_TOUCH_PX
            and y1 <= boxes[j][3] + CROWD_TOUCH_PX and boxes[j][1] <= y2 + CROWD_TOUCH_PX
            for j in g)]
        merged = [i] + [j for g in near for j in g]
        groups = [g for g in groups if g not in near] + [merged]
    return groups


def convert(
    image: np.ndarray,
    boxes: list[list[float]],
    *,
    set_image: Callable[[np.ndarray], None],
    predict_box: Callable[[np.ndarray], tuple[np.ndarray, float]],
    text_masks: Callable[[tuple[str, ...]], np.ndarray] | None = None,
    modes: list[str] | None = None,
    zoom: bool = True,
    epsilon_factor: float | None = None,
    keep_full: bool = False,
) -> list[BoxResult | None]:
    """Run every box. ``set_image`` encodes an image; ``predict_box``
    returns ``(mask, score)`` for an xyxy box in that image's pixels;
    ``text_masks`` returns the union of SAM's masks for some text prompts
    on the image currently set (``None`` when the model has no text
    prompts: ground and crowd then fall back to their box minus
    everything labelled).

    Crops are encoded first and the full image last. The full image is
    encoded when a box needs it, or when ``keep_full`` asks for it (the
    predictor was holding this image for the editor's own clicks and
    should be left holding it).
    """
    h, w = image.shape[:2]
    modes = list(modes or ["object"] * len(boxes))
    results: list[BoxResult | None] = [None] * len(boxes)
    shaped = [i for i, m in enumerate(modes) if m in BOX_MODES]
    regions = [i for i, m in enumerate(modes) if m in ("ground", "crowd")]
    pieces: dict[int, Piece] = {}
    scores: dict[int, tuple[float, bool]] = {}

    # Crowds: find the people on a zoomed crop of each crowd box (small,
    # distant spectators are missed on the full frame). The masks are
    # built once everything else is known, so they can give way to it.
    people: dict[int, np.ndarray] = {}
    if text_masks is not None:
        for i in (i for i in regions if modes[i] == "crowd"):
            x1, y1, x2, y2 = boxes[i]
            mx, my = CROWD_CROP_MARGIN * (x2 - x1), CROWD_CROP_MARGIN * (y2 - y1)
            cx0, cy0 = int(max(0, x1 - mx)), int(max(0, y1 - my))
            cx1, cy1 = int(min(w, x2 + mx)), int(min(h, y2 + my))
            set_image(np.ascontiguousarray(image[cy0:cy1, cx0:cx1]))
            found = text_masks(CROWD_PROMPTS)
            if found.shape == (h, w):
                # A whole-frame mask (a model that does not crop).
                people[i] = found
            else:
                people[i] = np.zeros((h, w), dtype=np.uint8)
                people[i][cy0:cy1, cx0:cx1] = found

    # What SAM is given: every shaped box, plus overlapping pieces of the
    # long flat ones. ``jobs[j] = (box index, box given)``.
    jobs: list[tuple[int, list[float]]] = []
    for i in shaped:
        jobs.append((i, boxes[i]))
        if modes[i] == "flat":
            jobs.extend((i, b) for b in _long_pieces(boxes[i]))
    found: dict[int, list[tuple[Piece, float, bool]]] = {}

    def take(j: int, mask: np.ndarray, score: float, zoomed: bool, offset: tuple[int, int]) -> None:
        i, given = jobs[j]
        piece = _clip(mask, given, offset)
        if piece is not None:
            found.setdefault(i, []).append((piece, score, zoomed))

    full_jobs, crops = plan([b for _, b in jobs], h, w, zoom=zoom)
    for c in crops:
        set_image(np.ascontiguousarray(image[c.y0 : c.y1, c.x0 : c.x1]))
        for j in c.members:
            x1, y1, x2, y2 = jobs[j][1]
            local = np.array([x1 - c.x0, y1 - c.y0, x2 - c.x0, y2 - c.y0], dtype=np.float32)
            m, score = predict_box(local)
            take(j, m, score, True, (c.x0, c.y0))
    named = [i for i in shaped if modes[i] in ("net", "ropes")]
    if full_jobs or regions or named or keep_full or not crops:
        set_image(image)
    for j in full_jobs:
        m, score = predict_box(np.asarray(jobs[j][1], dtype=np.float32))
        take(j, m, score, False, (0, 0))

    for i, got in found.items():
        if len(got) == 1:
            piece: Piece | None = got[0][0]
        else:
            joined = np.zeros((h, w), dtype=np.uint8)
            for p, _, _ in got:
                p.paste(joined)
            piece = _clip(joined, boxes[i], (0, 0))
        if modes[i] == "ropes":
            continue  # shaped below; the box prompt is only the fallback
        piece = _clean(piece, boxes[i], modes[i]) if piece else None
        if piece is not None:
            pieces[i] = _hull(piece) if modes[i] in ("carrier", "net") else piece
            scores[i] = (max(s for _, s, _ in got), any(z for _, _, z in got))

    # Nets and ropes by name, inside their box.
    strands: set[int] = set()
    if named and text_masks is not None:
        by_name: dict[tuple[str, ...], np.ndarray] = {}

        def named_piece(i: int, prompts: tuple[str, ...]) -> Piece | None:
            if prompts not in by_name:
                by_name[prompts] = text_masks(prompts)
            return _clip(by_name[prompts], boxes[i], (0, 0))

        for i in named:
            if modes[i] == "net":
                p = named_piece(i, NET_PROMPTS)
                p = _clean(p, boxes[i], "net") if p else None
                if p is not None:
                    pieces[i] = _hull(p)
                    scores[i] = (1.0, False)
                continue
            ropes = named_piece(i, ROPE_PROMPTS)
            ropes = _strands(ropes) if ropes else None
            cage = named_piece(i, CAGE_PROMPTS)
            cage = _clean(cage, boxes[i], "flat") if cage else None
            if ropes is not None and cage is not None:
                joined = np.zeros((h, w), dtype=np.uint8)
                ropes.paste(joined)
                cage.paste(joined)
                p = _clip(joined, boxes[i], (0, 0))
            else:
                p = ropes or cage
            if ropes is not None and cage is None:
                strands.add(i)  # ropes only: found as seen, nothing to cut
            if p is not None:
                pieces[i] = p
                scores[i] = (1.0, False)
    for i in (i for i in named if modes[i] == "ropes" and i not in pieces and i in found):
        # Nothing found by name: SAM's own mask, as it is.
        got = found[i]
        p = got[0][0] if len(got) == 1 else None
        p = _clean(p, boxes[i], "object") if p else None
        if p is not None:
            pieces[i] = p
            scores[i] = (got[0][1], got[0][2])

    # What stands in front of a see-through carrier cuts a hole in it
    # (its lowest pixel is below the carrier's in the same columns); what
    # is behind it shows through. Ropes are found as seen: nothing to cut.
    solid = [i for i in pieces if modes[i] in ("object", "flat")]
    for i in (i for i in pieces if modes[i] in SEE_THROUGH and i not in strands):
        carrier = pieces[i]
        ch, cw = carrier.m.shape
        for j in solid:
            other = pieces[j]
            if not _in_front(other, carrier):
                continue
            front = np.zeros((h, w), dtype=np.uint8)
            other.paste(front)
            carrier.m = carrier.m & (1 - front[carrier.y0 : carrier.y0 + ch, carrier.x0 : carrier.x0 + cw])

    claimed = np.zeros((h, w), dtype=np.uint8) if regions else None
    # An overlay SAM found nothing for is a see-through bug: its box.
    for i in shaped:
        if modes[i] == "overlay" and i not in pieces:
            results[i] = BoxResult(_box_polygon(boxes[i]), 0.0, False, translucent=True)
    for i, piece in pieces.items():
        score, zoomed = scores[i]
        mode = modes[i]
        if mode == "overlay":
            poly, translucent = _overlay_check(_polygon(piece, epsilon_factor), boxes[i])
            results[i] = BoxResult(poly, score, zoomed, translucent=translucent)
            if claimed is not None and not translucent:
                _claim(claimed, poly)
            continue
        if _is_simple(piece):
            poly = _polygon(piece, epsilon_factor)
            if poly:
                results[i] = BoxResult(poly, score, zoomed)
        else:
            full_mask = np.zeros((h, w), dtype=np.uint8)
            piece.paste(full_mask)
            if full_mask.any():
                results[i] = BoxResult([], score, zoomed, mask=full_mask)
        # See-through carriers do not hide the ground or a crowd.
        if claimed is not None and mode not in SEE_THROUGH and results[i] is not None:
            piece.paste(claimed)

    if regions:
        assert claimed is not None
        # The ground and crowds are closed across glass, nets and ropes.
        through = None
        see = [i for i in pieces if modes[i] in SEE_THROUGH]
        if see:
            through = np.zeros((h, w), dtype=np.uint8)
            for i in see:
                pieces[i].paste(through)
            through = cv2.dilate(through, np.ones((5, 5), np.uint8))
        # Crowds first: the ground gives way to them.
        crowds = [i for i in regions if modes[i] == "crowd"]
        for group in _touching(boxes, crowds):
            if text_masks is None:
                m = np.zeros((h, w), dtype=np.uint8)
                for i in group:
                    m |= _box_mask(boxes[i], h, w)
                m &= 1 - claimed
            else:
                seen = np.zeros((h, w), dtype=np.uint8)
                for i in group:
                    seen |= people[i]
                m = crowd_mask(seen, [boxes[i] for i in group], claimed, through)
            # One stand section: the largest box carries it.
            keep = max(group, key=lambda i: (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]))
            if m.any():
                results[keep] = BoxResult([], 1.0, False, mask=m)
                for i in group:
                    if i != keep:
                        results[i] = BoxResult([], 1.0, False, merged_into=keep)
            claimed |= m
        grounds = [i for i in regions if modes[i] == "ground"]
        if grounds:
            material = water = blockers = None
            if text_masks is not None:
                material = text_masks(GROUND_PROMPTS + GROUND_EXTRA_PROMPTS)
                water = text_masks(WATER_PROMPTS)
                blockers = text_masks(GROUND_BLOCKER_PROMPTS)
            for i in grounds:
                if material is None or water is None:
                    m = _box_mask(boxes[i], h, w) & (1 - claimed)
                else:
                    m = ground_mask(_with_water(material, water, boxes[i]), boxes[i], claimed, blockers, through)
                if m.any():
                    results[i] = BoxResult([], 1.0, False, mask=m)
    return results


def single_mask(masks: Any, scores: Any) -> tuple[np.ndarray, float]:
    """The predictor's single-mask output as ``(HxW uint8, score)``."""
    from carve_model.sam.perf import to_numpy_safe

    m = to_numpy_safe(masks)
    s = to_numpy_safe(scores)
    while m.ndim > 2:
        m = m[0]
    return (m > 0).astype(np.uint8), float(np.asarray(s, dtype=np.float32).reshape(-1)[0])
