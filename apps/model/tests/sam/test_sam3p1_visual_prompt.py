"""Tests for Sam3p1NativeImagePredictorAdapter.set_visual_prompt.

Avoids the real native sam3 package. Stubs the model + processor so we can
assert on shapes and lever behavior. Real model integration is covered by
the e2e + manual smoke tests.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import pytest

from carve_model.sam.sam3p1_adapter import Sam3p1NativeImagePredictorAdapter


def _stub_features(h, w, d=8, seed=0):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((h, w, d), dtype=np.float32)


def _build_adapter(fixed_state=None):
    model = MagicMock(name="Sam3Model")
    processor = MagicMock(name="Sam3Processor")
    def _set_image_stub(pil):
        if fixed_state is not None:
            return {**fixed_state, "original_height": pil.size[1], "original_width": pil.size[0]}
        return {
            "original_height": pil.size[1],
            "original_width": pil.size[0],
            "_stub_dense_hi": _stub_features(14, 14, 8, seed=1),
            "_stub_dense_lo": _stub_features(7, 7, 8, seed=2),
            "_stub_global": _stub_features(1, 1, 8, seed=3).reshape(8),
        }
    processor.set_image.side_effect = _set_image_stub
    return Sam3p1NativeImagePredictorAdapter(model=model, processor=processor, device="cpu")


def test_set_visual_prompt_bbox_returns_unit_norm_d_vector():
    adapter = _build_adapter()
    refer = np.random.default_rng(0).integers(0, 255, (100, 100, 3)).astype(np.uint8)
    out = adapter.set_visual_prompt(refer, {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert out.shape == (8,)
    np.testing.assert_allclose(np.linalg.norm(out), 1.0, atol=1e-5)


def test_set_visual_prompt_polygon_differs_from_bbox_on_same_shape():
    adapter = _build_adapter()
    refer = np.random.default_rng(1).integers(0, 255, (100, 100, 3)).astype(np.uint8)
    bbox_out = adapter.set_visual_prompt(refer, {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    poly_out = adapter.set_visual_prompt(
        refer, {"kind": "polygon", "points": [[10.0, 10.0], [30.0, 10.0], [20.0, 30.0]]}
    )
    assert not np.allclose(bbox_out, poly_out)


def test_dense_plus_global_default_is_alpha_0_7():
    fixed = {
        "_stub_dense_hi": np.tile(np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32), (4, 4, 1)),
        "_stub_dense_lo": np.tile(np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32), (2, 2, 1)),
        "_stub_global": np.array([0, 1, 0, 0, 0, 0, 0, 0], dtype=np.float32),
    }
    adapter = _build_adapter(fixed_state=fixed)
    out = adapter.set_visual_prompt(
        np.zeros((100, 100, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]},
    )
    expected_dense = np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    expected_global = np.array([0, 1, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    expected = 0.7 * expected_dense + 0.3 * expected_global
    expected = expected / np.linalg.norm(expected)
    np.testing.assert_allclose(out, expected, atol=1e-5)


def test_alpha_env_override(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_ALPHA", "0.5")
    adapter = _build_adapter()
    out = adapter.set_visual_prompt(
        np.zeros((100, 100, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]},
    )
    assert out.shape == (8,)
    np.testing.assert_allclose(np.linalg.norm(out), 1.0, atol=1e-5)


def test_min_size_guard_expands_tiny_region():
    adapter = _build_adapter()
    out = adapter.set_visual_prompt(
        np.zeros((200, 200, 3), dtype=np.uint8),
        {"kind": "bbox", "xyxy": [95.0, 95.0, 105.0, 105.0]},
    )
    assert out.shape == (8,)


def test_all_optional_levers_off_by_default(monkeypatch):
    for k in (
        "SAM_VISUAL_PROMPT_TTA_HFLIP", "SAM_VISUAL_PROMPT_TTA_VFLIP",
        "SAM_VISUAL_PROMPT_TTA_ROT90", "SAM_VISUAL_PROMPT_COLOR_AUG",
        "SAM_VISUAL_PROMPT_SELF_ATTN", "SAM_VISUAL_PROMPT_XIMG_REFINE",
    ):
        monkeypatch.delenv(k, raising=False)
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 1


def test_tta_hflip_env_doubles_encode(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_HFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_tta_vflip_env_doubles_encode(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_VFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_tta_rot90_env_runs_four_encodes(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_ROT90", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 4


def test_tta_compose_hflip_and_vflip(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_HFLIP", "1")
    monkeypatch.setenv("SAM_VISUAL_PROMPT_TTA_VFLIP", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 4


def test_color_aug_env_runs_twice(monkeypatch):
    monkeypatch.setenv("SAM_VISUAL_PROMPT_COLOR_AUG", "1")
    adapter = _build_adapter()
    adapter.set_visual_prompt(np.zeros((100, 100, 3), dtype=np.uint8),
                              {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]})
    assert adapter._processor.set_image.call_count == 2


def test_self_attn_pool_env_changes_output(monkeypatch):
    refer = np.zeros((100, 100, 3), dtype=np.uint8)
    region = {"kind": "bbox", "xyxy": [10.0, 10.0, 30.0, 30.0]}
    a1 = _build_adapter().set_visual_prompt(refer, region)
    monkeypatch.setenv("SAM_VISUAL_PROMPT_SELF_ATTN", "1")
    a2 = _build_adapter().set_visual_prompt(refer, region)
    assert not np.allclose(a1, a2, atol=1e-3)


def test_predict_with_visual_prompt_text_disabled():
    adapter = _build_adapter()
    target_state = {
        "original_height": 100, "original_width": 100,
        "_stub_dense_hi": _stub_features(14, 14, 8, seed=10),
        "_stub_dense_lo": _stub_features(7, 7, 8, seed=11),
        "_stub_global": _stub_features(1, 1, 8, seed=12).reshape(8),
    }
    adapter._state = target_state
    adapter._original_size = (100, 100)
    pooled = np.ones(8, dtype=np.float32) / np.sqrt(8)
    masks_returned = np.zeros((1, 100, 100), dtype=bool)
    masks_returned[0, 40:60, 40:60] = True
    adapter._model.predict_visual_prompt = MagicMock(
        return_value=(masks_returned, np.array([0.9]), np.array([[40.0, 40.0, 60.0, 60.0]]))
    )
    masks, scores, boxes = adapter.predict_with_visual_prompt(pooled)
    assert masks.shape == (1, 100, 100)
    assert scores[0] == pytest.approx(0.9)
    kwargs = adapter._model.predict_visual_prompt.call_args.kwargs
    assert kwargs.get("encode_text") is False
    assert kwargs.get("visual_prompt_embed").shape == (1, 1, 8)
