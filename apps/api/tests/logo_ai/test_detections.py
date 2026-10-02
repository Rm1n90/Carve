# Armin Mehri — mehri.armin@gmail.com
"""Parsing, coordinate mapping and cross-view merging (no DB, no network)."""

import json

import pytest

from carve_api.logo_ai.catalog import COORDS_GRID999, COORDS_PIXEL
from carve_api.logo_ai.detections import (
    BadModelOutput,
    Detection,
    merge_detections,
    parse_detections,
    to_original,
)
from carve_api.logo_ai.imaging import View
from carve_api.logo_ai.prompt import TargetClass, build_schema, build_system_text


def _answer(*rows) -> str:
    return json.dumps({"detections": list(rows)})


def _det(x1=10, y1=20, x2=110, y2=70, confidence=90, visible=100, label=None) -> list:
    """One answer row. The label is only present with several classes."""
    row = [x1, y1, x2, y2, confidence, visible]
    return row if label is None else [label, *row]


def test_parse_single_class_rows_have_no_label() -> None:
    (raw,) = parse_detections(_answer(_det(visible=65)), n_classes=1)
    assert raw == {
        "label": 1, "box": [10.0, 20.0, 110.0, 70.0], "confidence": 0.9, "visible": 65,
    }


def test_parse_multi_class_rows_lead_with_the_label() -> None:
    raw = parse_detections(_answer(_det(label=1), _det(label=2)), n_classes=2)
    assert [r["label"] for r in raw] == [1, 2]
    assert raw[0]["box"] == [10.0, 20.0, 110.0, 70.0]


def test_parse_drops_out_of_range_labels_and_malformed_rows() -> None:
    text = json.dumps(
        {
            "detections": [
                _det(label=3),            # no such class
                [1, 10, 20, 110],         # too short
                _det(),                   # single-class row in a two-class run
                "nope",
                [1, 10, 20, "x", 70, 90, 100],
                _det(label=1),
            ]
        }
    )
    assert len(parse_detections(text, n_classes=2)) == 1


@pytest.mark.parametrize("text", ["", "not json", "[]", '{"boxes": []}', '{"detections": 3}'])
def test_parse_rejects_answers_that_are_not_the_schema(text) -> None:
    with pytest.raises(BadModelOutput):
        parse_detections(text, n_classes=1)


def test_empty_list_is_a_valid_answer() -> None:
    assert parse_detections('{"detections": []}', n_classes=1) == []


def test_pixel_coords_scale_per_axis_to_the_original() -> None:
    # 4000x2000 original sent as 1000x500: every coordinate is x4.
    view = View(0, 0, 0, 4000, 2000, 1000, 500)
    raw = parse_detections(_answer(_det(x1=100, y1=50, x2=200, y2=100)), n_classes=1)
    (d,) = to_original(raw, view, coords=COORDS_PIXEL, image_w=4000, image_h=2000)
    assert (d.x1, d.y1, d.x2, d.y2) == (400, 200, 800, 400)
    assert d.class_index == 0 and d.confidence == 0.9 and d.visible == 100


def test_grid999_coords_span_the_whole_image() -> None:
    view = View(0, 0, 0, 2000, 1000, 1000, 500)
    raw = parse_detections(_answer(_det(x1=0, y1=0, x2=999, y2=999)), n_classes=1)
    (d,) = to_original(raw, view, coords=COORDS_GRID999, image_w=2000, image_h=1000)
    assert d.x1 == 0 and d.y1 == 0
    assert d.x2 == pytest.approx(1998) and d.y2 == pytest.approx(998)


def test_tile_coords_are_offset_by_the_tile_origin() -> None:
    view = View(1, 1000, 500, 3000, 1500, 1000, 500, is_tile=True)
    raw = parse_detections(_answer(_det(x1=500, y1=250, x2=600, y2=300)), n_classes=1)
    (d,) = to_original(raw, view, coords=COORDS_PIXEL, image_w=4000, image_h=3000)
    assert (d.x1, d.y1, d.x2, d.y2) == (2000, 1000, 2200, 1100)
    assert d.from_tile and not d.edge_cut


def test_boxes_are_clamped_unswapped_and_degenerate_ones_dropped() -> None:
    view = View(0, 0, 0, 1000, 1000, 1000, 1000)
    raw = parse_detections(
        _answer(
            _det(x1=900, y1=900, x2=1500, y2=1200),  # spills out
            _det(x1=300, y1=300, x2=200, y2=100),    # corners swapped
            _det(x1=50, y1=50, x2=50, y2=400),       # zero width
        ),
        n_classes=1,
    )
    a, b = to_original(raw, view, coords=COORDS_PIXEL, image_w=1000, image_h=1000)
    assert (a.x2, a.y2) == (1000, 1000)
    assert (b.x1, b.y1, b.x2, b.y2) == (200, 100, 300, 300)


def test_edge_cut_only_for_interior_tile_edges() -> None:
    # Tile in the top-left corner: its left/top are image borders, its
    # right/bottom are interior.
    view = View(1, 0, 0, 2000, 2000, 1000, 1000, is_tile=True)
    raw = parse_detections(
        _answer(
            _det(x1=0, y1=0, x2=100, y2=100),       # touches image border only
            _det(x1=900, y1=400, x2=1000, y2=500),  # touches interior right edge
        ),
        n_classes=1,
    )
    a, b = to_original(raw, view, coords=COORDS_PIXEL, image_w=4000, image_h=4000)
    assert not a.edge_cut
    assert b.edge_cut


def _d(x1, y1, x2, y2, conf=0.8, cls=0, tile=False, cut=False, visible=100) -> Detection:
    return Detection(cls, x1, y1, x2, y2, conf, visible=visible, from_tile=tile, edge_cut=cut)


def test_merge_collapses_the_same_logo_seen_by_two_views() -> None:
    full = _d(100, 100, 200, 200, conf=0.7)
    tile = _d(102, 98, 203, 201, conf=0.6, tile=True)
    (kept,) = merge_detections([full, tile])
    # The tile's box wins (drawn at higher resolution); confidence is
    # the better of the two.
    assert kept.from_tile and kept.x1 == 102
    assert kept.confidence == 0.7


def test_merge_keeps_the_larger_visibility_of_two_views() -> None:
    # A tile cuts through a logo the full frame shows whole: the logo is
    # fully visible in the image, whatever the tile made of it.
    full = _d(100, 100, 200, 200, visible=100)
    tile = _d(101, 99, 201, 201, tile=True, visible=55)
    (kept,) = merge_detections([full, tile])
    assert kept.from_tile and kept.visible == 100


def test_merge_keeps_different_classes_and_distant_boxes() -> None:
    dets = [
        _d(0, 0, 100, 100),
        _d(0, 0, 100, 100, cls=1),      # same place, other class
        _d(500, 500, 600, 600),         # same class, elsewhere
    ]
    assert len(merge_detections(dets)) == 3


def test_merge_drops_a_fragment_covered_by_a_whole_box() -> None:
    whole = _d(100, 100, 400, 200, conf=0.8)
    fragment = _d(100, 100, 250, 200, conf=0.9, tile=True, cut=True)
    (kept,) = merge_detections([fragment, whole])
    assert (kept.x1, kept.x2) == (100, 400)
    assert kept.confidence == 0.9


def test_merge_joins_two_fragments_of_one_logo() -> None:
    # The logo spans two tiles and the full frame missed it.
    left = _d(100, 100, 260, 200, tile=True, cut=True)
    right = _d(240, 100, 400, 200, tile=True, cut=True)
    # The shared strip is only 20px of 160: not enough to call them one.
    assert len(merge_detections([left, right])) == 2
    wide_left = _d(100, 100, 300, 200, tile=True, cut=True)
    wide_right = _d(220, 100, 400, 200, tile=True, cut=True)
    (joined,) = merge_detections([wide_left, wide_right])
    assert (joined.x1, joined.x2) == (100, 400)


# --- prompt + schema -------------------------------------------------------

_CLASSES = [
    TargetClass("a", "Acme", "red wordmark in a circle"),
    TargetClass("b", "Globex", ""),
]


def test_schema_is_strict_and_provider_safe() -> None:
    anthropic = build_schema(2, COORDS_PIXEL, numeric_bounds=False)
    assert anthropic["additionalProperties"] is False
    assert anthropic["required"] == ["detections"]
    row = anthropic["properties"]["detections"]["items"]
    assert row == {"type": "array", "items": {"type": "integer"}}
    # Anthropic rejects numeric bounds and array length limits with a 400.
    flat = json.dumps(anthropic)
    for keyword in ("minimum", "maximum", "minItems", "maxItems"):
        assert keyword not in flat

    # OpenAI enforces the row length and the value range.
    one = build_schema(1, COORDS_GRID999, numeric_bounds=True)["properties"]["detections"]["items"]
    assert (one["minItems"], one["maxItems"]) == (6, 6)
    assert one["items"] == {"type": "integer", "minimum": 0, "maximum": 999}
    two = build_schema(2, COORDS_GRID999, numeric_bounds=True)["properties"]["detections"]["items"]
    assert (two["minItems"], two["maxItems"]) == (7, 7)


def test_system_text_is_stable_and_lists_the_classes() -> None:
    text = build_system_text(_CLASSES, COORDS_PIXEL)
    # Byte-identical across calls: it is the cached prefix.
    assert text == build_system_text(_CLASSES, COORDS_PIXEL)
    assert "1. Acme: red wordmark in a circle" in text
    assert "2. Globex" in text and "2. Globex:" not in text
    assert "pixels" in text
    assert "0 to 999" in build_system_text(_CLASSES, COORDS_GRID999)
    # The row layout the parser expects is the one the prompt describes.
    assert "[label, x1, y1, x2, y2, confidence, visible]" in text
    single = build_system_text(_CLASSES[:1], COORDS_PIXEL)
    assert "`[x1, y1, x2, y2, confidence, visible]`" in single and "`label`" not in single


def test_prompt_asks_for_hidden_logos_to_be_reported_not_dropped() -> None:
    # Filtering by visibility happens in our code, on the number the
    # model reports. If the prompt also told it to leave such logos out
    # there would be nothing to filter, and no threshold to tune.
    text = build_system_text(_CLASSES[:1], COORDS_GRID999)
    assert "## Visibility" in text
    assert "rather than leaving them out" in text


def test_minimal_prompt_still_clears_the_cache_minimum() -> None:
    # One class, no description: the shortest prefix a run can have.
    # OpenAI caches nothing under 1,024 tokens (current Claude models
    # under 512), so the rubric alone has to clear it. English prose
    # runs about 1.3 tokens per word.
    for coords in (COORDS_PIXEL, COORDS_GRID999):
        text = build_system_text([TargetClass("a", "Logo", "")], coords)
        assert len(text.split()) * 1.3 > 1024 * 1.1
