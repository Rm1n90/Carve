"""Verify Sam3p1Variant.predict_visual uses the variant's own adapter — not a
second visual-predictor singleton. Completes the OOM-fix invariant: one
Sam3p1NativeImagePredictorAdapter serves point + text + box + visual.
"""
from unittest.mock import MagicMock, patch

import base64
import numpy as np
from io import BytesIO
from PIL import Image

from carve_model.sam.lifecycle import Sam3p1Variant


def _b64_zero_image() -> str:
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_predict_visual_uses_same_adapter():
    """Visual prompts share the adapter with point + text + box.

    The OOM-fix invariant: one Sam3p1NativeImagePredictorAdapter instance
    serves all four predict methods.
    """
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {
            "original_height": int(image.shape[0]),
            "original_width": int(image.shape[1]),
        }

    adapter.set_image.side_effect = fake_set_image

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(v, "_run_visual_inference", return_value=[]), \
             patch(
                 "carve_model.sam.lifecycle._crop_refer_with_mask",
                 return_value=(np.zeros((4, 4, 3), dtype=np.uint8), None),
             ), patch(
                 "carve_model.sam.lifecycle.embed_image",
                 return_value=np.ones(512, dtype=np.float32),
             ):
            v.predict_visual(
                target_b64=_b64_zero_image(),
                refer_b64=_b64_zero_image(),
                regions=[{"kind": "bbox", "xyxy": [0, 0, 2, 2]}],
            )
        v.predict_point(
            point_coords=np.array([[2, 2]]),
            point_labels=np.array([1]),
        )
        assert build.call_count == 1


def test_predict_visual_returns_empty_when_no_regions():
    adapter = MagicMock()
    adapter._device = "cuda"
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        result = v.predict_visual(
            target_b64=_b64_zero_image(),
            refer_b64=_b64_zero_image(),
            regions=[],
        )
        assert result == []


def test_predict_visual_raises_when_not_loaded():
    import pytest
    v = Sam3p1Variant()  # never called load()
    with pytest.raises(RuntimeError, match="called before load"):
        v.predict_visual(
            target_b64=_b64_zero_image(),
            refer_b64=_b64_zero_image(),
            regions=[{"kind": "bbox", "xyxy": [0, 0, 2, 2]}],
        )
