"""Verify Sam3p1Variant.predict_text uses the variant's own adapter — not a
second _NATIVE_IMAGE_PREDICTOR singleton. This is the structural fix for
the double-load OOM bug."""
from unittest.mock import MagicMock, patch

import numpy as np

from carve_model.sam.lifecycle import Sam3p1Variant


def _b64_zero_image() -> str:
    import base64
    from io import BytesIO
    from PIL import Image
    pil = Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8))
    buf = BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _build_fake_adapter():
    adapter = MagicMock()
    adapter._device = "cuda"

    def fake_set_image(image):
        adapter._state = {
            "original_height": int(image.shape[0]),
            "original_width": int(image.shape[1]),
        }
    adapter.set_image.side_effect = fake_set_image

    def fake_set_text(text, state):
        state["masks"] = MagicMock()
        state["masks_logits"] = MagicMock()
        state["boxes"] = MagicMock()
        state["scores"] = MagicMock()
    adapter._processor.set_text_prompt.side_effect = fake_set_text
    adapter._processor.confidence_threshold = 0.5
    return adapter


def test_predict_text_reuses_same_adapter_as_point_no_double_load():
    """The critical assertion: predict_text and predict_point share the same
    underlying adapter instance."""
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[],
        ), patch(
            "carve_model.sam.lifecycle.to_numpy_safe",
            return_value=np.zeros((0, 4)),
        ):
            v.predict_text(image_b64=_b64_zero_image(), text="hat")
        v.predict_point(
            point_coords=np.array([[2, 2]]),
            point_labels=np.array([1]),
        )
        assert build.call_count == 1


def test_predict_text_threshold_restored_after_call():
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[],
        ), patch(
            "carve_model.sam.lifecycle.to_numpy_safe",
            return_value=np.zeros((0, 4)),
        ):
            v.predict_text(image_b64=_b64_zero_image(), text="hat", threshold=0.2)
        assert fake_adapter._processor.set_confidence_threshold.call_count == 2


def test_predict_text_returns_rows_in_score_order():
    fake_adapter = _build_fake_adapter()
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch(
            "carve_model.sam.lifecycle._extract_text_detections",
            return_value=[
                (np.zeros((4, 4), dtype=np.uint8), 0.4),
                (np.zeros((4, 4), dtype=np.uint8), 0.9),
            ],
        ):
            with patch(
                "carve_model.sam.lifecycle.encode_mask_rle",
                return_value=("rle", [4, 4]),
            ):
                with patch(
                    "carve_model.sam.lifecycle.mask_to_polygon",
                    return_value=[],
                ):
                    with patch(
                        "carve_model.sam.lifecycle.to_numpy_safe",
                        return_value=np.array([[0, 0, 1, 1], [0, 0, 2, 2]]),
                    ):
                        out = v.predict_text(
                            image_b64=_b64_zero_image(), text="hat"
                        )
        assert len(out) == 2
        assert out[0]["score"] == 0.9
        assert out[1]["score"] == 0.4
