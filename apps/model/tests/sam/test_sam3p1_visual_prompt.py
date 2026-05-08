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
