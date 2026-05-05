"""Tests for VLM-FO1 output parsing.

VLM-FO1 emits output in this canonical format (per om-ai-lab/VLM-FO1
``vlm_fo1.mm_utils.extract_predictions_to_indexes``):

    <ground>label text</ground><objects><region0><region5></objects>

The parser must extract referenced region indexes, tolerate bare
``<regionN>`` tokens without the ``<ground>`` wrapper, deduplicate,
preserve first-seen order, and filter out-of-range indexes.

Pure-logic tests — no transformers, torch, or PIL imports.
"""

from model_vlm_fo1.runner import _extract_indexes


def test_extract_canonical_ground_objects_envelope():
    out = _extract_indexes(
        "<ground>lion</ground><objects><region0><region2></objects>",
        n_boxes=4,
    )
    assert out == [0, 2]


def test_extract_multiple_ground_blocks_unioned():
    out = _extract_indexes(
        "<ground>lion</ground><objects><region0></objects>"
        "<ground>lion</ground><objects><region2></objects>",
        n_boxes=4,
    )
    assert sorted(out) == [0, 2]


def test_extract_bare_region_tokens_without_envelope():
    out = _extract_indexes("<region0>, <region2>", n_boxes=4)
    assert out == [0, 2]


def test_extract_dedups_repeated_indexes():
    out = _extract_indexes("<region1><region1><region1>", n_boxes=4)
    assert out == [1]


def test_extract_filters_out_of_range_indexes():
    out = _extract_indexes("<region99><region2>", n_boxes=4)
    assert out == [2]


def test_extract_returns_empty_for_empty_string():
    assert _extract_indexes("", n_boxes=4) == []


def test_extract_returns_empty_when_no_tokens_found():
    out = _extract_indexes("no objects matched the query.", n_boxes=4)
    assert out == []


def test_extract_tolerates_underscore_spelling():
    out = _extract_indexes("<region_0>, <region_2>", n_boxes=4)
    assert sorted(out) == [0, 2]


def test_extract_preserves_first_seen_order():
    out = _extract_indexes("<region3><region0><region2>", n_boxes=4)
    assert out == [3, 0, 2]


def test_extract_handles_zero_boxes():
    assert _extract_indexes("<region0>", n_boxes=0) == []
