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
  on the image (cars, boards, people) is cut out. Only the course is
  kept: the parts the competitors stand on, and parts of the same
  surface. A field or garden beside an open road (dirt and grass where
  the riders are on asphalt) touches the road only through a narrow neck
  and is cut off there. A box side drawn just short of the frame edge,
  that the ground runs into, is taken to the edge: the surface goes on
  there, and the box would cut it off in a straight line.
* **crowd**: the people SAM 3.1 finds with the prompt "person" inside
  the box, joined across the small gaps between them, without the
  competitors it finds there ("athlete", "cyclist"): a crowd box is a
  rectangle, and the riders passing the stand inside it are not
  spectators.

Both come back as pixel masks (they have holes and several parts). An
**overlay** box (a broadcast graphic) keeps SAM's outline when SAM finds
the graphic, and falls back to the box for a faint, see-through bug
where SAM only finds a blob of the scene behind it. An opaque overlay
(a design element, a panel, a photo inset) gives way to what is labelled
inside it: the cars, boards, track and crowd of an inset are cut out of
it and keep their own labels, and a ground or crowd box inside it is not
blocked by it.

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
whole row keeps one board of it. When SAM given the whole box already
runs its full length, and is sure of it (a barrier at an angle across
its box), that mask is kept alone: a piece's square then holds mostly what lies beside the
barrier (track, crowd), and SAM takes that. Crowd boxes that touch are one stand
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
# Competitors inside a crowd box (riders passing a stand, the back of a
# peloton) are not spectators. On the test frames these find riders,
# boxers, fighters and surfers and no one in a stand; "racer" and
# "player" also fire on spectators.
ATHLETE_PROMPTS = ("athlete", "cyclist")
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
# A ground box's side this close to the frame edge (share of the frame's
# width or height) is taken to the edge when the ground runs into it along
# at least GROUND_RUNS_ON of its length: the box was drawn short of a
# surface that fills the frame there.
GROUND_EDGE_SNAP = 0.1
GROUND_RUNS_ON = 0.25
# Ground parts joined by a neck narrower than this share of the image's
# long side are separate parts (a field beside an open road).
COURSE_NECK = 0.005
# A part is the course when it holds at least this share of the
# competitors standing on the ground...
COURSE_STANDING = 0.1
# ...or when at least half of it is a surface they stand on: one found
# under at least this share of them, relative to the most found one.
COURSE_SURFACE = 0.5
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
# SAM's mask for the whole long box is kept alone when it covers at least
# this share of the box's length, with at least this score (an unsure one
# spanning it is usually a thin line or the pitch along a row of boards).
LONG_SPAN = 0.8
LONG_SCORE = 0.7
# Crowd boxes closer than this (pixels) are one area.
CROWD_TOUCH_PX = 4
# A box with at least this share of it inside a bigger overlay's box lies
# inside that overlay (an inset's car, its track).
INSET_SHARE = 0.8


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


def _spans(piece: Piece, box: list[float]) -> bool:
    """The mask covers at least LONG_SPAN of its long box's length."""
    x1, y1, x2, y2 = box
    along = 0 if x2 - x1 >= y2 - y1 else 1
    lo, hi = (x1, x2) if along == 0 else (y1, y2)
    start = piece.x0 if along == 0 else piece.y0
    at = start + np.flatnonzero(piece.m.any(axis=along))
    return int(((at >= lo) & (at < hi)).sum()) >= LONG_SPAN * (hi - lo)


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


def _inside(inner: list[float], outer: list[float]) -> bool:
    """``inner`` lies inside ``outer``: smaller, and at least INSET_SHARE
    of it within ``outer``. A scene object partly hidden behind a graphic
    runs out of the graphic's box."""
    ix1, iy1, ix2, iy2 = inner
    ox1, oy1, ox2, oy2 = outer
    area = (ix2 - ix1) * (iy2 - iy1)
    if area <= 0 or area >= (ox2 - ox1) * (oy2 - oy1):
        return False
    over = max(0.0, min(ix2, ox2) - max(ix1, ox1)) * max(0.0, min(iy2, oy2) - max(iy1, oy1))
    return over >= INSET_SHARE * area


def _pixels(r: BoxResult, h: int, w: int) -> np.ndarray:
    """A result as a full-image mask."""
    if r.mask is not None:
        return (r.mask > 0).astype(np.uint8)
    m = np.zeros((h, w), dtype=np.uint8)
    _claim(m, r.polygon)
    return m


def _trim(piece: Piece, box: list[float]) -> Piece | None:
    """A design element with its insets cut out: the slivers left along
    the cuts and the specks dropped; the cuts stay open, however small."""
    m = piece.m
    if min(box[2] - box[0], box[3] - box[1]) >= CLEANUP_MIN_SIDE:
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    total = int(m.sum())
    if total == 0:
        return None
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= max(16, PART_MIN * total)]
    if not keep:
        return None
    return Piece(piece.x0, piece.y0, np.isin(labels, keep).astype(np.uint8))


def _box_mask(box: list[float], h: int, w: int) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.uint8)
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    m[max(0, y1) : min(h, y2), max(0, x1) : min(w, x2)] = 1
    return m


def _to_frame_edges(g: np.ndarray, box: list[float]) -> list[float]:
    """The ground box with each side near the frame edge that the ground
    ``g`` runs into taken to that edge (GROUND_EDGE_SNAP, GROUND_RUNS_ON)."""
    h, w = g.shape
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    out = [float(v) for v in box]
    if x2 - x1 < 3 or y2 - y1 < 3:
        return out
    sides = (
        (0, 0.0, 0 < x1 <= GROUND_EDGE_SNAP * w, g[y1:y2, x1 : x1 + 3].any(axis=1)),
        (1, 0.0, 0 < y1 <= GROUND_EDGE_SNAP * h, g[y1 : y1 + 3, x1:x2].any(axis=0)),
        (2, float(w), (1 - GROUND_EDGE_SNAP) * w <= x2 < w, g[y1:y2, x2 - 3 : x2].any(axis=1)),
        (3, float(h), (1 - GROUND_EDGE_SNAP) * h <= y2 < h, g[y2 - 3 : y2, x1:x2].any(axis=0)),
    )
    for k, edge, near, touched in sides:
        if near and touched.mean() >= GROUND_RUNS_ON:
            out[k] = edge
    return out


def _fill_holes(m: np.ndarray) -> np.ndarray:
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m)
    cv2.drawContours(out, cnts, -1, 1, thickness=cv2.FILLED)
    return out


def _course(
    g: np.ndarray, base: np.ndarray, standing: list[list[float]], surfaces: dict[str, np.ndarray]
) -> np.ndarray:
    """The parts of the ground that are the course: those holding the
    competitors (``standing``: boxes whose bottom may rest on the ground),
    and those mostly of a surface they stand on (``surfaces``: each
    ground prompt's mask). A field, garden or pavement beside an open
    road touches it only through a narrow neck: the parts are told apart
    with that neck cut, and the edges the cut took are given back to the
    parts kept."""
    h, w = g.shape
    k = max(5, int(COURSE_NECK * max(h, w))) | 1
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    # Outside the image counts as not ground, so a neck along the frame
    # edge is cut too.
    opened = cv2.morphologyEx(g, cv2.MORPH_OPEN, disc, borderType=cv2.BORDER_CONSTANT, borderValue=0)
    n, labels = cv2.connectedComponents(opened, connectivity=8)
    if n <= 2:
        return g
    # What each one stands on: a band across the bottom of its box.
    hits = np.zeros(n, dtype=np.int64)
    votes = dict.fromkeys(surfaces, 0)
    voters = 0
    for x1, y1, x2, y2 in standing:
        bh = y2 - y1
        bx0, bx1 = int(max(0, x1)), int(min(w, x2))
        by0, by1 = int(max(0, y2 - 0.1 * bh)), int(min(h, y2 + max(4.0, 0.15 * bh)))
        if bx1 <= bx0 or by1 <= by0:
            continue
        under = np.unique(labels[by0:by1, bx0:bx1])
        under = under[under > 0]
        if under.size == 0:
            continue
        hits[under] += 1
        voters += 1
        need = 0.1 * (by1 - by0) * (bx1 - bx0)
        for p, m in surfaces.items():
            if int(m[by0:by1, bx0:bx1].sum()) >= need:
                votes[p] += 1
    if voters == 0:
        return g
    top = max(votes.values(), default=0)
    on = np.zeros((h, w), dtype=bool)
    for p, v in votes.items():
        if top and v >= COURSE_SURFACE * top:
            on |= surfaces[p] > 0
    b = base > 0
    size = np.bincount(labels[b], minlength=n)
    same = np.bincount(labels[b & on], minlength=n)
    keep = [c for c in range(1, n) if hits[c] >= max(1.0, COURSE_STANDING * voters) or (size[c] and 2 * same[c] >= size[c])]
    kept = np.isin(labels, keep).astype(np.uint8)
    return g & cv2.dilate(kept, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k + 2, k + 2)))


def ground_mask(
    material: np.ndarray,
    box: list[float],
    claimed: np.ndarray,
    blockers: np.ndarray | None = None,
    through: np.ndarray | None = None,
    standing: list[list[float]] | None = None,
    surfaces: dict[str, np.ndarray] | None = None,
) -> np.ndarray:
    """Ground-material pixels inside the box (kerbs and painted markings
    included), holes and short gaps filled (painted logos, lines, kerbs),
    except where something that is not ground stands (``blockers``:
    people, trees, buildings, walls, fences, poles, sky), closed across
    see-through carriers (``through``), only the course (see
    :func:`_course`; when ``standing`` and ``surfaces`` are given), minus
    everything else labelled."""
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
        if standing and surfaces:
            g = _course(g, base, standing, surfaces)
    return g & (1 - claimed)


def _wet(land: np.ndarray, water: np.ndarray, box: list[float]) -> bool:
    """The water is most of what the box holds."""
    h, w = land.shape
    inside = _box_mask(box, h, w).astype(bool)
    return int((water > 0)[inside].sum()) > int((land > 0)[inside].sum())


def _with_water(land: np.ndarray, water: np.ndarray, box: list[float]) -> np.ndarray:
    """The ground material for one box: the land, plus the water when the
    water is most of what the box holds."""
    land = (land > 0).astype(np.uint8)
    return land | (water > 0).astype(np.uint8) if _wet(land, water, box) else land


def crowd_mask(
    people: np.ndarray,
    boxes: list[float] | list[list[float]],
    claimed: np.ndarray,
    through: np.ndarray | None = None,
    athletes: np.ndarray | None = None,
) -> np.ndarray:
    """People inside the box (or the touching boxes, as one area) joined
    across small gaps and across ropes and nets, minus the competitors
    found there (``athletes``) and anything else labelled; the boxes
    themselves when no person is found."""
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
    if athletes is not None and athletes.any():
        # After the joining, so it cannot close over them again.
        c &= 1 - cv2.dilate((athletes > 0).astype(np.uint8), np.ones((5, 5), np.uint8))
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
    athletes: dict[int, np.ndarray] = {}
    if text_masks is not None:
        for i in (i for i in regions if modes[i] == "crowd"):
            x1, y1, x2, y2 = boxes[i]
            mx, my = CROWD_CROP_MARGIN * (x2 - x1), CROWD_CROP_MARGIN * (y2 - y1)
            cx0, cy0 = int(max(0, x1 - mx)), int(max(0, y1 - my))
            cx1, cy1 = int(min(w, x2 + mx)), int(min(h, y2 + my))
            set_image(np.ascontiguousarray(image[cy0:cy1, cx0:cx1]))
            for into, prompts in ((people, CROWD_PROMPTS), (athletes, ATHLETE_PROMPTS)):
                found = text_masks(prompts)
                if found.shape == (h, w):
                    # A whole-frame mask (a model that does not crop).
                    into[i] = found
                else:
                    into[i] = np.zeros((h, w), dtype=np.uint8)
                    into[i][cy0:cy1, cx0:cx1] = found

    # What SAM is given: every shaped box, plus overlapping pieces of the
    # long flat ones. ``jobs[j] = (box index, box given)``.
    jobs: list[tuple[int, list[float]]] = []
    whole_job: dict[int, int] = {}
    for i in shaped:
        whole_job[i] = len(jobs)
        jobs.append((i, boxes[i]))
        if modes[i] == "flat":
            jobs.extend((i, b) for b in _long_pieces(boxes[i]))
    found: dict[int, list[tuple[Piece, float, bool]]] = {}
    whole: dict[int, tuple[Piece, float, bool]] = {}

    def take(j: int, mask: np.ndarray, score: float, zoomed: bool, offset: tuple[int, int]) -> None:
        i, given = jobs[j]
        piece = _clip(mask, given, offset)
        if piece is not None:
            found.setdefault(i, []).append((piece, score, zoomed))
            if j == whole_job[i]:
                whole[i] = (piece, score, zoomed)

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
        if len(got) > 1 and i in whole and whole[i][1] >= LONG_SCORE and _spans(whole[i][0], boxes[i]):
            got = [whole[i]]  # the whole run found at once; the pieces add what lies beside it
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
    # Opaque overlays, finished last: what is labelled inside one is cut
    # out of it, and a ground or crowd lying inside it is not blocked by it.
    opaque: dict[int, np.ndarray] = {}
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
            if not translucent:
                opaque[i] = np.zeros((h, w), dtype=np.uint8)
                _claim(opaque[i], poly)
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

        def taken(group: list[int]) -> np.ndarray:
            """What a region may not take: everything labelled, and every
            opaque overlay except the ones it lies inside (the track in a
            photo inset is the inset's ground)."""
            out = claimed.copy()
            for o, om in opaque.items():
                if not all(_inside(boxes[i], boxes[o]) for i in group):
                    out |= om
            return out

        # Crowds first: the ground gives way to them.
        crowds = [i for i in regions if modes[i] == "crowd"]
        for group in _touching(boxes, crowds):
            if text_masks is None:
                m = np.zeros((h, w), dtype=np.uint8)
                for i in group:
                    m |= _box_mask(boxes[i], h, w)
                m &= 1 - taken(group)
            else:
                seen = np.zeros((h, w), dtype=np.uint8)
                competing = np.zeros((h, w), dtype=np.uint8)
                for i in group:
                    seen |= people[i]
                    competing |= athletes[i]
                m = crowd_mask(seen, [boxes[i] for i in group], taken(group), through, competing)
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
            surfaces: dict[str, np.ndarray] = {}
            if text_masks is not None:
                # One prompt at a time: the course is told by the surface
                # its competitors stand on (asphalt, not the field beside).
                surfaces = {p: text_masks((p,)) for p in GROUND_PROMPTS}
                material = text_masks(GROUND_EXTRA_PROMPTS)
                for s in surfaces.values():
                    material = material | s
                water = text_masks(WATER_PROMPTS)
                blockers = text_masks(GROUND_BLOCKER_PROMPTS)
            # What may stand on the ground: objects, but not the spectators
            # and their things inside a crowd box.
            stands = [boxes[i] for i in regions if modes[i] == "crowd"]
            standing = [boxes[j] for j, m in enumerate(modes) if m == "object" and not any(_inside(boxes[j], c) for c in stands)]
            for i in grounds:
                if material is None or water is None:
                    m = _box_mask(boxes[i], h, w) & (1 - taken([i]))
                else:
                    wet = _wet(material, water, boxes[i])
                    on = {**surfaces, WATER_PROMPTS[0]: water} if wet else surfaces
                    stuff = _with_water(material, water, boxes[i])
                    m = ground_mask(stuff, boxes[i], taken([i]), blockers, through, standing, on)
                    # A box drawn just short of the frame edge cuts the
                    # ground off in a straight line: take it to the edge
                    # (not out of a photo inset it lies in).
                    wide = _to_frame_edges(m, boxes[i])
                    if wide != boxes[i] and not any(_inside(boxes[i], boxes[o]) for o in opaque):
                        m = ground_mask(stuff, wide, taken([i]), blockers, through, standing, on)
                if m.any():
                    results[i] = BoxResult([], 1.0, False, mask=m)

    # A design element keeps only what nothing else inside it is labelled
    # as: an inset's cars, boards, track and crowd keep their own labels.
    for o, om in opaque.items():
        cut = np.zeros((h, w), dtype=np.uint8)
        for j, r in enumerate(results):
            if j != o and r is not None and not r.translucent and r.merged_into is None and _inside(boxes[j], boxes[o]):
                cut |= _pixels(r, h, w)
        if not (om & cut).any():
            continue
        piece = _clip(om & (1 - cut), boxes[o], (0, 0))
        piece = _trim(piece, boxes[o]) if piece else None
        if piece is None:
            continue
        r = results[o]
        assert r is not None
        if _is_simple(piece):
            results[o] = BoxResult(_polygon(piece, epsilon_factor), r.score, r.zoomed)
        else:
            full_mask = np.zeros((h, w), dtype=np.uint8)
            piece.paste(full_mask)
            results[o] = BoxResult([], r.score, r.zoomed, mask=full_mask)
    return results


def single_mask(masks: Any, scores: Any) -> tuple[np.ndarray, float]:
    """The predictor's single-mask output as ``(HxW uint8, score)``."""
    from carve_model.sam.perf import to_numpy_safe

    m = to_numpy_safe(masks)
    s = to_numpy_safe(scores)
    while m.ndim > 2:
        m = m[0]
    return (m > 0).astype(np.uint8), float(np.asarray(s, dtype=np.float32).reshape(-1)[0])
