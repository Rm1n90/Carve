# Armin Mehri — mehri.armin@gmail.com
"""Image preparation for Logo AI.

Vision models bill an image by the number of fixed-size patches it
covers (28px on Anthropic, 32px on OpenAI) and silently downscale
anything above their resolution cap. Both facts matter here:

* **Cost** — an image whose sides are not patch multiples is padded up
  to the next patch, so part of the last row/column is paid for and
  carries no pixels. Anything above the cap is paid for at the cap and
  the extra bytes are thrown away.
* **Accuracy** — the model returns pixel coordinates in the image *it*
  sees. If the provider resizes behind our back the boxes land in a
  coordinate space we never observed.

So every image is resized here, once, to exactly ``cols × rows`` whole
patches inside the model's budget. The image we hold is then the image
the model sees, every paid patch is full of pixels, and boxes map back
to the original with two multiplications.

Small logos do not survive a heavy downscale, so a large original can
additionally be cut into overlapping tiles (each again resized to the
native grid) and the per-view detections merged afterwards.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageDraw, ImageOps

# JPEG quality for what we upload. Tokens are billed by pixel area, not
# bytes, so this only trades request size against compression artefacts
# on small marks; 90 keeps fine edges without bloating a 96MB batch part.
_JPEG_QUALITY = 90

# Fraction of a tile shared with its neighbour. A logo narrower than
# the overlap is always whole in at least one tile.
_TILE_OVERLAP = 0.18


@dataclass(frozen=True)
class GridSpec:
    """How one model bills and caps an image."""

    patch: int          # patch side in px
    max_edge: int       # longest side the model accepts without resizing
    max_patches: int    # patch budget per image


@dataclass(frozen=True)
class View:
    """One image sent to the model: a crop of the original, resized.

    ``(x0, y0, x1, y1)`` is the crop in original pixels; ``out_w`` ×
    ``out_h`` is the size actually sent. ``index`` 0 is always the full
    image; tiles follow.
    """

    index: int
    x0: int
    y0: int
    x1: int
    y1: int
    out_w: int
    out_h: int
    is_tile: bool = False

    def to_original(self, x: float, y: float) -> tuple[float, float]:
        sx = (self.x1 - self.x0) / self.out_w
        sy = (self.y1 - self.y0) / self.out_h
        return self.x0 + x * sx, self.y0 + y * sy

    def as_list(self) -> list[int]:
        return [
            self.index, self.x0, self.y0, self.x1, self.y1,
            self.out_w, self.out_h, int(self.is_tile),
        ]

    @classmethod
    def from_list(cls, raw: list[int]) -> View:
        return cls(
            index=int(raw[0]), x0=int(raw[1]), y0=int(raw[2]),
            x1=int(raw[3]), y1=int(raw[4]), out_w=int(raw[5]),
            out_h=int(raw[6]), is_tile=bool(raw[7]),
        )


def image_patches(width: int, height: int, patch: int) -> int:
    """Patches an image of this size is billed for."""
    return math.ceil(width / patch) * math.ceil(height / patch)


def fit_grid(width: int, height: int, spec: GridSpec) -> tuple[int, int]:
    """Size to send: whole patches, inside the edge and patch budgets.

    Never upscales beyond rounding a side up to its next patch multiple.
    The result can differ from the source aspect ratio by under one
    patch per side; coordinates are mapped back per-axis so that skew
    costs nothing.
    """
    if width <= 0 or height <= 0:
        raise ValueError("empty image")
    p = spec.patch
    scale = min(
        1.0,
        spec.max_edge / max(width, height),
        math.sqrt(spec.max_patches * p * p / (width * height)),
    )
    max_side = max(1, spec.max_edge // p)
    cols = min(max_side, max(1, round(width * scale / p)))
    rows = min(max_side, max(1, round(height * scale / p)))
    # Rounding both sides up can overshoot the budget by a row or
    # column; shave whichever side leaves the aspect ratio closest to
    # the original.
    target = math.log(width / height)
    while cols * rows > spec.max_patches:
        options = [(c, r) for c, r in ((cols - 1, rows), (cols, rows - 1)) if c and r]
        cols, rows = min(options, key=lambda cr: abs(math.log(cr[0] / cr[1]) - target))
    return cols * p, rows * p


def _tile_edges(length: int, count: int) -> list[tuple[int, int]]:
    """``count`` equal, overlapping spans covering ``[0, length]``."""
    if count <= 1:
        return [(0, length)]
    size = math.ceil(length / (count - (count - 1) * _TILE_OVERLAP))
    size = min(size, length)
    step = (length - size) / (count - 1)
    return [(round(i * step), round(i * step) + size) for i in range(count)]


def plan_views(
    width: int, height: int, spec: GridSpec, *, max_tiles_per_side: int = 0
) -> list[View]:
    """Views to send for one image: the full frame, then optional tiles.

    Tiles are only added where they buy resolution: a side is split when
    the original is wider than what one view can show at native scale.
    ``max_tiles_per_side`` 0 disables tiling.
    """
    out_w, out_h = fit_grid(width, height, spec)
    views = [View(0, 0, 0, width, height, out_w, out_h)]
    if max_tiles_per_side <= 1:
        return views
    # The full frame already goes out at (nearly) its own resolution: a
    # tile would show the model the same pixels again at extra cost. A
    # tall or wide image can fit the patch budget whole and still be
    # longer than one square tile, so this has to be checked directly.
    if out_w * out_h >= 0.8 * width * height:
        return views
    # Side of a square view at the full patch budget — the most original
    # pixels one tile can carry without being downscaled.
    native = min(spec.max_edge, int(math.sqrt(spec.max_patches)) * spec.patch)
    nx = min(max_tiles_per_side, math.ceil(width / native))
    ny = min(max_tiles_per_side, math.ceil(height / native))
    if nx * ny <= 1:
        return views
    idx = 1
    for ty0, ty1 in _tile_edges(height, ny):
        for tx0, tx1 in _tile_edges(width, nx):
            tw, th = fit_grid(tx1 - tx0, ty1 - ty0, spec)
            views.append(View(idx, tx0, ty0, tx1, ty1, tw, th, is_tile=True))
            idx += 1
    return views


def load_image(data: bytes) -> Image.Image:
    """Decode to RGB in display orientation (EXIF applied, alpha on white)."""
    im = Image.open(BytesIO(data))
    im = ImageOps.exif_transpose(im) or im
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        return background
    if im.mode != "RGB":
        return im.convert("RGB")
    return im


def _encode_jpeg(im: Image.Image) -> bytes:
    out = BytesIO()
    im.save(out, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
    return out.getvalue()


def render_view(im: Image.Image, view: View) -> bytes:
    """JPEG bytes for one view, at exactly ``view.out_w × view.out_h``."""
    region = im
    if (view.x0, view.y0, view.x1, view.y1) != (0, 0, im.width, im.height):
        region = im.crop((view.x0, view.y0, view.x1, view.y1))
    if region.size != (view.out_w, view.out_h):
        region = region.resize((view.out_w, view.out_h), Image.LANCZOS)
    return _encode_jpeg(region)


def render_reference_crop(
    im: Image.Image, bbox_xyxy: tuple[float, float, float, float], spec: GridSpec
) -> bytes:
    """A small exemplar crop of one annotated logo, with a little context.

    Exemplars sit in the cached prompt prefix and are re-read on every
    request, so they are kept to a few dozen patches each.
    """
    x1, y1, x2, y2 = bbox_xyxy
    pad = 0.12 * max(x2 - x1, y2 - y1)
    box = (
        max(0, int(x1 - pad)), max(0, int(y1 - pad)),
        min(im.width, int(math.ceil(x2 + pad))),
        min(im.height, int(math.ceil(y2 + pad))),
    )
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        raise ValueError("reference box is empty")
    crop = im.crop(box)
    small = GridSpec(patch=spec.patch, max_edge=spec.patch * 8, max_patches=48)
    w, h = fit_grid(crop.width, crop.height, small)
    return _encode_jpeg(crop.resize((w, h), Image.LANCZOS))


# A check sheet: every candidate box of an image, enlarged, on one
# numbered grid. At detection size a small mark is a few dozen pixels;
# here each gets a tile of its own, which is what lets a second look
# tell a logo from a stripe.
CHECK_TILE = 192
CHECK_COLS = 6
CHECK_MAX_TILES = 36
_CHECK_LABEL = 18


def render_check_sheet(
    im: Image.Image, boxes: list[tuple[float, float, float, float]]
) -> bytes:
    """JPEG of up to ``CHECK_MAX_TILES`` numbered tiles, one per box
    (xyxy, original pixels), each a crop with as much context around the
    box as the box is large, and the box drawn in green."""
    rows = (len(boxes) + CHECK_COLS - 1) // CHECK_COLS
    sheet = Image.new(
        "RGB", (CHECK_COLS * CHECK_TILE, rows * (CHECK_TILE + _CHECK_LABEL)), (20, 20, 20)
    )
    draw = ImageDraw.Draw(sheet)
    for i, (x1, y1, x2, y2) in enumerate(boxes):
        half = max(x2 - x1, y2 - y1) + 10
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        left, top = int(max(0, cx - half)), int(max(0, cy - half))
        right = int(min(im.width, math.ceil(cx + half)))
        bottom = int(min(im.height, math.ceil(cy + half)))
        crop = im.crop((left, top, max(right, left + 1), max(bottom, top + 1)))
        scale = CHECK_TILE / max(crop.width, crop.height)
        crop = crop.resize(
            (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
            Image.LANCZOS,
        )
        ImageDraw.Draw(crop).rectangle(
            [(x1 - left) * scale, (y1 - top) * scale, (x2 - left) * scale, (y2 - top) * scale],
            outline=(0, 255, 0),
            width=2,
        )
        px = (i % CHECK_COLS) * CHECK_TILE
        py = (i // CHECK_COLS) * (CHECK_TILE + _CHECK_LABEL)
        offset_x = px + (CHECK_TILE - crop.width) // 2
        offset_y = py + _CHECK_LABEL + (CHECK_TILE - crop.height) // 2
        sheet.paste(crop, (offset_x, offset_y))
        draw.rectangle([px, py, px + 34, py + _CHECK_LABEL - 2], fill=(255, 255, 0))
        draw.text((px + 4, py + 2), str(i + 1), fill=(0, 0, 0))
    return _encode_jpeg(sheet)
