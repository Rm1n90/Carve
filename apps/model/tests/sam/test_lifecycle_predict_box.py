"""Verify Sam3p1Variant.predict_box uses the variant's own adapter — not a
second _NATIVE_IMAGE_PREDICTOR singleton. This is the structural fix for
the double-load OOM bug (Task 2.2 follows Task 2.1's pattern for text)."""
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


def test_predict_box_uses_same_adapter():
    """Box prompts share the adapter with point + text — no second model load."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(v, "_run_box_predict_inst", return_value=None):
            v.predict_box(
                image_b64=_b64_zero_image(),
                boxes=[[0, 0, 1, 1]],
                box_labels=[1],
            )
        v.predict_point(
            point_coords=np.array([[2, 2]]),
            point_labels=np.array([1]),
        )
        assert build.call_count == 1


def test_predict_box_returns_empty_when_no_positive_masks():
    """No positive masks → empty list."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(v, "_run_box_predict_inst", return_value=None):
            out = v.predict_box(
                image_b64=_b64_zero_image(),
                boxes=[[0, 0, 1, 1]],
                box_labels=[1],
            )
        assert out == []


def test_predict_box_returns_rows_sorted_by_score_desc():
    """Two positive boxes → two rows sorted by score desc."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    mask_a = np.ones((4, 4), dtype=np.uint8)
    mask_b = np.ones((4, 4), dtype=np.uint8)
    # The two calls return different (mask, score) pairs.
    side_effects = [(mask_a, 0.3), (mask_b, 0.9)]

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(
            v,
            "_run_box_predict_inst",
            side_effect=side_effects,
        ), patch(
            "carve_model.sam.lifecycle.encode_mask_rle",
            return_value=("rle", [4, 4]),
        ), patch(
            "carve_model.sam.lifecycle.mask_to_polygon",
            return_value=[],
        ):
            out = v.predict_box(
                image_b64=_b64_zero_image(),
                boxes=[[0, 0, 1, 1], [2, 2, 3, 3]],
                box_labels=[1, 1],
            )

        assert len(out) == 2
        assert out[0]["score"] == 0.9
        assert out[1]["score"] == 0.3


def test_predict_box_negative_subtracts_from_positive():
    """A negative box should subtract from the union of positive masks."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None

    def fake_set_image(image):
        adapter._state = {"original_height": 4, "original_width": 4}

    adapter.set_image.side_effect = fake_set_image

    pos_mask = np.ones((4, 4), dtype=np.uint8)
    neg_mask = np.zeros((4, 4), dtype=np.uint8)
    neg_mask[0, 0] = 1
    side_effects = [(pos_mask, 0.8), (neg_mask, 0.5)]

    captured_masks: list[np.ndarray] = []

    def fake_encode(m):
        captured_masks.append(np.asarray(m).copy())
        return ("rle", [4, 4])

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with patch.object(
            v,
            "_run_box_predict_inst",
            side_effect=side_effects,
        ), patch(
            "carve_model.sam.lifecycle.encode_mask_rle",
            side_effect=fake_encode,
        ), patch(
            "carve_model.sam.lifecycle.mask_to_polygon",
            return_value=[],
        ):
            out = v.predict_box(
                image_b64=_b64_zero_image(),
                boxes=[[0, 0, 1, 1], [2, 2, 3, 3]],
                box_labels=[1, 0],
            )

        assert len(out) == 1
        # The encoded mask should be the positive mask minus the negative.
        assert len(captured_masks) == 1
        encoded = captured_masks[0]
        assert encoded[0, 0] == 0  # negative subtracted
        assert encoded[1, 1] == 1  # positive remains


def test_predict_box_returns_empty_when_state_none():
    """If adapter._state is None after set_image, return []."""
    adapter = MagicMock()
    adapter._device = "cuda"
    adapter._state = None
    adapter.set_image = MagicMock()  # does not set _state

    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=adapter,
    ):
        v = Sam3p1Variant()
        v.load(device="cuda")
        out = v.predict_box(
            image_b64=_b64_zero_image(),
            boxes=[[0, 0, 1, 1]],
            box_labels=[1],
        )
        assert out == []


def test_predict_box_raises_when_not_loaded():
    """predict_box before load() raises RuntimeError."""
    import pytest

    v = Sam3p1Variant()
    with pytest.raises(RuntimeError):
        v.predict_box(
            image_b64=_b64_zero_image(),
            boxes=[[0, 0, 1, 1]],
            box_labels=[1],
        )
