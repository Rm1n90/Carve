# Armin Mehri — mehri.armin@gmail.com
"""Native-grid sizing, tiling and coordinate mapping (no DB, no network)."""

from io import BytesIO

import pytest
from PIL import Image

from carve_api.logo_ai import catalog
from carve_api.logo_ai.imaging import (
    GridSpec,
    View,
    fit_grid,
    image_patches,
    load_image,
    plan_views,
    render_reference_crop,
    render_view,
)

CLAUDE_STD = GridSpec(patch=28, max_edge=1568, max_patches=1568)
CLAUDE_HI = GridSpec(patch=28, max_edge=2576, max_patches=4784)
GPT_HIGH = GridSpec(patch=32, max_edge=2048, max_patches=2500)


def _jpeg(w: int, h: int, color=(120, 30, 200)) -> bytes:
    out = BytesIO()
    Image.new("RGB", (w, h), color).save(out, format="JPEG")
    return out.getvalue()


@pytest.mark.parametrize("spec", [CLAUDE_STD, CLAUDE_HI, GPT_HIGH])
@pytest.mark.parametrize(
    "size",
    [(1920, 1080), (3840, 2160), (1075, 1520), (640, 480), (5000, 300), (100, 4000), (37, 53)],
)
def test_fit_grid_is_whole_patches_inside_both_budgets(spec, size) -> None:
    w, h = fit_grid(*size, spec)
    assert w % spec.patch == 0 and h % spec.patch == 0
    assert w >= spec.patch and h >= spec.patch
    assert max(w, h) <= spec.max_edge
    # Every billed patch is full: billed == covered.
    assert image_patches(w, h, spec.patch) == (w // spec.patch) * (h // spec.patch)
    assert image_patches(w, h, spec.patch) <= spec.max_patches


def test_fit_grid_matches_the_documented_claude_sizes() -> None:
    # Anthropic's own examples: 1920x1080 is resized to 1456x819 on the
    # standard tier and 3840x2160 to 2576x1449 on the high-res tier,
    # then padded to the next 28px. Ours are those sizes with the
    # padding filled by image instead.
    assert fit_grid(1920, 1080, CLAUDE_STD) == (1456, 840)
    assert fit_grid(3840, 2160, CLAUDE_HI) == (2576, 1456)


def test_fit_grid_does_not_upscale_small_images() -> None:
    w, h = fit_grid(640, 480, CLAUDE_HI)
    assert abs(w - 640) < 28 and abs(h - 480) < 28


def test_detail_lowers_the_budget_but_never_raises_it() -> None:
    haiku = catalog.get_model("anthropic", "claude-haiku-4-5")
    opus = catalog.get_model("anthropic", "claude-opus-5-5")
    assert catalog.grid_for(opus, "max").max_patches == 4784
    assert catalog.grid_for(opus, "low").max_patches < catalog.grid_for(opus, "high").max_patches
    # "high" asks for more than Haiku's tier allows; it is clamped.
    assert catalog.grid_for(haiku, "high").max_patches == 1568


def test_plan_views_full_frame_only_by_default() -> None:
    views = plan_views(4000, 3000, CLAUDE_HI)
    assert len(views) == 1
    assert (views[0].x0, views[0].y0, views[0].x1, views[0].y1) == (0, 0, 4000, 3000)
    assert not views[0].is_tile


def test_plan_views_tiles_cover_the_image_with_overlap() -> None:
    views = plan_views(4000, 3000, CLAUDE_STD, max_tiles_per_side=2)
    tiles = [v for v in views if v.is_tile]
    assert views[0].index == 0 and not views[0].is_tile
    assert len(tiles) == 4
    assert min(t.x0 for t in tiles) == 0 and max(t.x1 for t in tiles) == 4000
    assert min(t.y0 for t in tiles) == 0 and max(t.y1 for t in tiles) == 3000
    # Neighbours overlap, so a logo on the seam is whole in one of them.
    left, right = sorted({(t.x0, t.x1) for t in tiles})
    assert right[0] < left[1]
    for t in tiles:
        assert image_patches(t.out_w, t.out_h, 28) <= CLAUDE_STD.max_patches


def test_plan_views_skips_tiles_that_buy_no_resolution() -> None:
    # Already at native scale in one view: tiling would only cost more.
    assert len(plan_views(1000, 800, CLAUDE_HI, max_tiles_per_side=3)) == 1


def test_plan_views_skips_tiles_when_the_full_frame_is_not_downscaled() -> None:
    # A 1080x1920 portrait fits OpenAI's budget whole (1088x1920), but
    # is taller than one square tile. Tiling it would triple the cost
    # for no extra detail.
    views = plan_views(1080, 1920, GPT_HIGH, max_tiles_per_side=3)
    assert [(v.out_w, v.out_h) for v in views] == [(1088, 1920)]


def test_view_maps_sent_coordinates_back_to_the_original() -> None:
    view = View(index=1, x0=1000, y0=500, x1=3000, y1=1500, out_w=1000, out_h=500, is_tile=True)
    assert view.to_original(0, 0) == (1000, 500)
    assert view.to_original(1000, 500) == (3000, 1500)
    assert view.to_original(500, 250) == (2000, 1000)
    assert View.from_list(view.as_list()) == view


def test_render_view_emits_exactly_the_planned_size() -> None:
    im = load_image(_jpeg(1920, 1080))
    for view in plan_views(1920, 1080, CLAUDE_STD, max_tiles_per_side=2):
        with Image.open(BytesIO(render_view(im, view))) as out:
            assert out.size == (view.out_w, view.out_h)
            assert out.format == "JPEG"


def test_render_view_is_deterministic() -> None:
    # The prompt cache needs byte-identical reference crops across the
    # requests of a run (and across worker processes).
    im = load_image(_jpeg(800, 600))
    view = plan_views(800, 600, CLAUDE_HI)[0]
    assert render_view(im, view) == render_view(im, view)


def test_load_image_flattens_alpha_and_applies_exif_orientation() -> None:
    rgba = BytesIO()
    Image.new("RGBA", (40, 20), (255, 0, 0, 0)).save(rgba, format="PNG")
    im = load_image(rgba.getvalue())
    assert im.mode == "RGB"
    assert im.getpixel((0, 0)) == (255, 255, 255)  # transparent → white

    rotated = BytesIO()
    src = Image.new("RGB", (40, 20), (1, 2, 3))
    exif = src.getexif()
    exif[0x0112] = 6  # rotate 90° to display
    src.save(rotated, format="JPEG", exif=exif)
    assert load_image(rotated.getvalue()).size == (20, 40)


def test_reference_crop_is_small_and_on_the_grid() -> None:
    im = load_image(_jpeg(2000, 1500))
    crop = render_reference_crop(im, (500, 400, 900, 600), CLAUDE_HI)
    with Image.open(BytesIO(crop)) as out:
        assert out.width % 28 == 0 and out.height % 28 == 0
        assert image_patches(out.width, out.height, 28) <= 48
    with pytest.raises(ValueError):
        render_reference_crop(im, (10, 10, 10, 10), CLAUDE_HI)


def test_check_sheet_has_one_numbered_tile_per_box() -> None:
    from io import BytesIO

    from carve_api.logo_ai.imaging import CHECK_COLS, CHECK_TILE, render_check_sheet

    im = Image.new("RGB", (800, 600), (0, 0, 200))
    boxes = [(10, 10, 60, 40), (700, 500, 799, 599), (300, 200, 320, 215)] + [(100, 100, 150, 150)] * 5
    with Image.open(BytesIO(render_check_sheet(im, boxes))) as sheet:
        # Eight boxes: two rows of the six-column grid.
        assert sheet.width == CHECK_COLS * CHECK_TILE
        assert CHECK_TILE * 2 < sheet.height < CHECK_TILE * 2 + 60
        # Each tile shows its crop (blue), with the box drawn in green.
        px = sheet.convert("RGB").load()
        first_tile = [px[x, y] for x in range(CHECK_TILE) for y in range(20, CHECK_TILE)]
        assert any(g > 150 and r < 120 and b < 130 for r, g, b in first_tile)
        assert any(b > 150 and g < 80 for r, g, b in first_tile)
