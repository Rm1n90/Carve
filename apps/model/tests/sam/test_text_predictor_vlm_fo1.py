"""Tests for the VLM-FO1 integration into ``make_sam3_text_predictor``.

The closure returned by ``make_sam3_text_predictor`` gains an optional
``use_vlm_fo1: bool = False`` kwarg. When False (default), behavior is
byte-for-byte identical to today — SAM 3 concept segmentation at the
existing 0.5 threshold, no top-K cap, no FO1 call.

When ``use_vlm_fo1=True`` AND a filter has been registered via
``predictor.set_vlm_fo1_filter``:

  - SAM 3's ``post_process_instance_segmentation`` is called at the
    ``SAM3_PROPOSAL_THRESHOLD`` env value (default 0.2) so FO1 sees
    higher recall.
  - Results are sorted by score desc and capped at
    ``SAM3_TOPK_PROPOSALS`` (default 64) before the filter call.
  - The filter receives ``(image_pil, text, boxes_xyxy)`` and returns
    the indexes that match — the closure subsets the result list.

When ``use_vlm_fo1=True`` but NO filter is registered, the closure
falls back to passthrough silently (no exception). The HTTP boundary
surfaces ``vlm_fo1_available=false`` so the client can render the
right state.
"""

from __future__ import annotations

from typing import Any

import pytest

from carve_model.sam import predictor as p_mod
from carve_model.sam import sam3_adapter as a_mod

# Re-use the shared fixture from the existing SAM 3 adapter test file.
from tests.sam.test_sam3_adapter import (  # type: ignore[import-not-found]
    fake_sam3_concept_image_modules,
)


# 1×1 transparent PNG, valid base64 — public-domain test pixel.
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _stub_text_predictor_build_concept(monkeypatch, fake_concept_modules):
    """Patch ``a_mod._build_concept_image_pair`` to return the fake
    concept model + processor + device tuple."""
    _, FakeModel, FakeProcessor = fake_concept_modules

    def _fake_build():
        return FakeModel(), FakeProcessor(), "cpu"

    monkeypatch.setattr(a_mod, "_build_concept_image_pair", _fake_build)


@pytest.fixture(autouse=True)
def _reset_vlm_fo1_filter():
    """Each test starts with a clean filter slot."""
    p_mod.reset_vlm_fo1_filter()
    yield
    p_mod.reset_vlm_fo1_filter()


# --- registration tests (predictor.py) -------------------------------------


def test_set_get_vlm_fo1_filter_round_trip():
    sentinel = lambda **kw: []  # noqa: E731
    p_mod.set_vlm_fo1_filter(sentinel)
    assert p_mod.get_vlm_fo1_filter() is sentinel


def test_get_vlm_fo1_filter_returns_none_when_unset():
    assert p_mod.get_vlm_fo1_filter() is None


def test_reset_vlm_fo1_filter_clears():
    p_mod.set_vlm_fo1_filter(lambda **kw: [])
    p_mod.reset_vlm_fo1_filter()
    assert p_mod.get_vlm_fo1_filter() is None


# --- closure-level behavior --------------------------------------------------


def test_text_predictor_passes_through_when_use_vlm_fo1_false(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """Default path: behavior identical to pre-FO1. No filter call,
    threshold=0.5."""
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    filter_calls: list[dict] = []
    p_mod.set_vlm_fo1_filter(
        lambda *, image, text, boxes: filter_calls.append({"text": text}) or [0],
    )

    fn = a_mod.make_sam3_text_predictor()
    out = fn(image_b64=_TINY_PNG_B64, text="lion")

    assert filter_calls == []
    assert captured["post_kwargs"]["threshold"] == 0.5
    assert isinstance(out, list)


def test_text_predictor_lowers_threshold_when_use_vlm_fo1_true(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """FO1 active → SAM 3 over-generates at the lower threshold."""
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    p_mod.set_vlm_fo1_filter(lambda *, image, text, boxes: list(range(len(boxes))))

    fn = a_mod.make_sam3_text_predictor()
    fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert captured["post_kwargs"]["threshold"] == pytest.approx(0.2, rel=1e-3)


def test_text_predictor_threshold_overridable_via_env(
    monkeypatch, fake_sam3_concept_image_modules,
):
    captured, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)
    monkeypatch.setenv("SAM3_PROPOSAL_THRESHOLD", "0.1")

    p_mod.set_vlm_fo1_filter(lambda *, image, text, boxes: list(range(len(boxes))))

    fn = a_mod.make_sam3_text_predictor()
    fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert captured["post_kwargs"]["threshold"] == pytest.approx(0.1, rel=1e-3)


def test_text_predictor_calls_filter_with_image_text_boxes(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """The filter receives PIL image (not bytes), original text, box list."""
    _, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    received: dict[str, Any] = {}

    def _filter(*, image, text, boxes):
        received["image_size"] = image.size
        received["text"] = text
        received["boxes"] = list(boxes)
        return list(range(len(boxes)))

    p_mod.set_vlm_fo1_filter(_filter)

    fn = a_mod.make_sam3_text_predictor()
    fn(image_b64=_TINY_PNG_B64, text="ball nearest the bear", use_vlm_fo1=True)

    assert received["text"] == "ball nearest the bear"
    assert len(received["boxes"]) == 2
    for box in received["boxes"]:
        assert len(box) == 4


def test_text_predictor_subsets_results_to_filter_indexes(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """Filter returning [1] keeps only the second proposal."""
    _, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    p_mod.set_vlm_fo1_filter(lambda *, image, text, boxes: [1])

    fn = a_mod.make_sam3_text_predictor()
    out = fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert len(out) == 1


def test_text_predictor_passthrough_when_use_vlm_fo1_true_but_no_filter(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """Operator never wired a real filter — fall back to SAM 3 raw output."""
    _, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    fn = a_mod.make_sam3_text_predictor()
    out = fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert len(out) == 2


def test_text_predictor_caps_at_top_k_when_use_vlm_fo1_true(
    monkeypatch, fake_sam3_concept_image_modules,
):
    _, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)
    monkeypatch.setenv("SAM3_TOPK_PROPOSALS", "1")

    received_box_count: list[int] = []

    def _filter(*, image, text, boxes):
        received_box_count.append(len(boxes))
        return list(range(len(boxes)))

    p_mod.set_vlm_fo1_filter(_filter)

    fn = a_mod.make_sam3_text_predictor()
    fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert received_box_count == [1]


def test_text_predictor_handles_filter_exception_with_passthrough(
    monkeypatch, fake_sam3_concept_image_modules,
):
    """Filter raising must NOT bubble up — degrade to raw SAM 3 output."""
    _, _, _ = fake_sam3_concept_image_modules
    _stub_text_predictor_build_concept(monkeypatch, fake_sam3_concept_image_modules)

    def _exploding_filter(*, image, text, boxes):
        raise RuntimeError("simulated FO1 OOM")

    p_mod.set_vlm_fo1_filter(_exploding_filter)

    fn = a_mod.make_sam3_text_predictor()
    out = fn(image_b64=_TINY_PNG_B64, text="lion", use_vlm_fo1=True)

    assert len(out) == 2
