"""Tests for VLM-FO1 output parsing.

VLM-FO1 emits output in this canonical format (per om-ai-lab/VLM-FO1
``vlm_fo1.mm_utils.extract_predictions_to_indexes``):

    <ground>label text</ground><objects><region0><region5></objects>

Region tokens are ``<regionN>`` with no underscore, no separators. The
parser must:

  - Extract all referenced region indexes from the canonical envelope
  - Tolerate bare ``<regionN>`` tokens without the ``<ground>...</ground>``
    wrapper (some prompt variants and partial decodes drop it)
  - Tolerate alternate spellings (``<region_N>``, ``region N``,
    ``<rN>``) seen in our tests / future prompt variants
  - Deduplicate, preserve first-seen order, filter out-of-range indexes
  - Return a list — at the adapter layer we don't care about labels
    because we only ever send a single text query at a time

Pure-logic tests — no transformers, torch, or PIL imports.
"""

from carve_model.vlm_fo1.adapter import _extract_indexes_from_output


# --- canonical FO1 format ---------------------------------------------------


def test_extract_canonical_ground_objects_envelope():
    out = _extract_indexes_from_output(
        "<ground>lion</ground><objects><region0><region2></objects>",
        n_boxes=4,
    )
    assert out == [0, 2]


def test_extract_multiple_ground_blocks_unioned():
    """Two <ground> blocks for the same query collapse to a union."""
    out = _extract_indexes_from_output(
        "<ground>lion</ground><objects><region0></objects>"
        "<ground>lion</ground><objects><region2></objects>",
        n_boxes=4,
    )
    assert sorted(out) == [0, 2]


def test_extract_bare_region_tokens_without_envelope():
    """Some decodes truncate the <ground>...</ground> wrapper; bare
    <regionN> tokens still parse."""
    out = _extract_indexes_from_output("<region0>, <region2>", n_boxes=4)
    assert out == [0, 2]


# --- defensive / alternate-spelling tolerance ------------------------------


def test_extract_dedups_repeated_indexes():
    out = _extract_indexes_from_output("<region1><region1><region1>", n_boxes=4)
    assert out == [1]


def test_extract_filters_out_of_range_indexes():
    out = _extract_indexes_from_output("<region99><region2>", n_boxes=4)
    assert out == [2]


def test_extract_returns_empty_for_empty_string():
    assert _extract_indexes_from_output("", n_boxes=4) == []


def test_extract_returns_empty_when_no_tokens_found():
    out = _extract_indexes_from_output("no objects matched the query.", n_boxes=4)
    assert out == []


def test_extract_tolerates_underscore_spelling():
    out = _extract_indexes_from_output("<region_0>, <region_2>", n_boxes=4)
    assert sorted(out) == [0, 2]


def test_extract_preserves_first_seen_order():
    out = _extract_indexes_from_output("<region3><region0><region2>", n_boxes=4)
    assert out == [3, 0, 2]


def test_extract_handles_zero_boxes():
    assert _extract_indexes_from_output("<region0>", n_boxes=0) == []
