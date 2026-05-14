"""Unit tests for the bbox-IoU NMS helpers used by auto_text_for_asset.

Covers the "two near-identical polygons on the same object" regression
where SAM 3 / 3.1's grounding head occasionally emits multiple
overlapping proposals (especially with multi-fragment comma-split
prompts) and the editor rendered all of them as separate annotations.
"""
from __future__ import annotations

from carve_api.inference.auto_text import (
    _NMS_IOU_THRESHOLD,
    _iou_xyxy,
    _nms_dedupe,
)


def _det(bbox: list[float], score: float) -> dict:
    return {"bbox": bbox, "score": score, "polygon": [], "counts": "", "size": [10, 10]}


class TestIouXyxy:
    def test_identical_boxes_iou_is_one(self) -> None:
        assert _iou_xyxy([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0

    def test_disjoint_boxes_iou_is_zero(self) -> None:
        assert _iou_xyxy([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0

    def test_partial_overlap_is_below_one(self) -> None:
        # Two 10×10 boxes offset by 5 → 5×10 intersection = 50,
        # union = 100 + 100 - 50 = 150 → IoU = 1/3
        iou = _iou_xyxy([0, 0, 10, 10], [5, 0, 15, 10])
        assert abs(iou - (1 / 3)) < 1e-6

    def test_degenerate_box_returns_zero(self) -> None:
        # Zero-area box should never be treated as overlapping anything.
        assert _iou_xyxy([5, 5, 5, 5], [0, 0, 10, 10]) == 0.0

    def test_short_box_returns_zero_not_indexerror(self) -> None:
        assert _iou_xyxy([0, 0, 10], [0, 0, 10, 10]) == 0.0


class TestNmsDedupe:
    def test_empty_input_returns_empty(self) -> None:
        assert _nms_dedupe([]) == []

    def test_single_input_passes_through(self) -> None:
        det = _det([0, 0, 10, 10], 0.5)
        result = _nms_dedupe([det])
        assert len(result) == 1
        assert result[0] is det

    def test_drops_near_duplicate_keeping_higher_score(self) -> None:
        # Two overlapping detections of "the same eye" — the higher-
        # scored one wins, the duplicate is dropped. IoU here is
        # 99/101 ≈ 0.98 — well above the 0.70 default and typical of
        # SAM-side near-duplicates on the same object.
        higher = _det([0, 0, 100, 100], 0.9)
        lower = _det([0, 0, 99, 100], 0.7)
        result = _nms_dedupe([lower, higher])
        assert len(result) == 1
        assert result[0]["score"] == 0.9

    def test_keeps_two_genuinely_separate_objects(self) -> None:
        # Two pants on two people standing apart — IoU < threshold,
        # both should survive.
        a = _det([0, 0, 10, 10], 0.8)
        b = _det([100, 0, 110, 10], 0.6)
        result = _nms_dedupe([a, b])
        assert len(result) == 2

    def test_moderate_overlap_pair_survives_at_default_threshold(self) -> None:
        # IoU = 1/3 (~0.33) is well below the 0.70 default, so both
        # should survive — confirms the default isn't over-aggressive.
        a = _det([0, 0, 10, 10], 0.9)
        b = _det([5, 0, 15, 10], 0.85)
        result = _nms_dedupe([a, b])
        assert len(result) == 2

    def test_explicit_threshold_can_be_aggressive(self) -> None:
        # With an explicit 0.30 threshold the 1/3 IoU pair collapses.
        a = _det([0, 0, 10, 10], 0.9)
        b = _det([5, 0, 15, 10], 0.85)
        result = _nms_dedupe([a, b], iou_threshold=0.30)
        assert len(result) == 1
        assert result[0]["score"] == 0.9

    def test_constant_threshold_value(self) -> None:
        # Guard against accidental regressions of the documented default.
        assert _NMS_IOU_THRESHOLD == 0.70

    def test_three_near_duplicates_collapse_to_best(self) -> None:
        # Three masks on the same 100-pixel object, each with tiny
        # 1-pixel offsets → pairwise IoUs ≥ 0.95 → all collapse to
        # the highest-scored.
        a = _det([0, 0, 100, 100], 0.6)
        b = _det([0, 0, 99, 100], 0.8)
        c = _det([0, 0, 100, 99], 0.9)
        result = _nms_dedupe([a, b, c])
        assert len(result) == 1
        assert result[0]["score"] == 0.9
