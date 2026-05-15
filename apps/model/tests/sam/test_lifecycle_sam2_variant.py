from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import SamCapabilityError, Sam2Variant


@pytest.fixture
def fake_adapter():
    adapter = MagicMock()
    adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )
    adapter.extract_embedding.return_value = b"emb"
    return adapter


def test_sam2_variant_load_builds_adapter(fake_adapter):
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        build.assert_called_once_with("sam2.1-large", device="cuda")
        assert v.name == "sam2.1-large"
        assert v.device == "cuda"


def test_sam2_variant_unload_drops_adapter(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        v.unload()
        assert v.cached_image_hash() is None


def test_sam2_variant_set_image_returns_hash(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        img = np.zeros((10, 10, 3), dtype=np.uint8)
        h = v.set_image(img)
        assert isinstance(h, str) and len(h) == 64
        assert v.cached_image_hash() == h
        assert v.cached_image_shape() == (10, 10)
        fake_adapter.set_image.assert_called_once()


def test_sam2_variant_predict_point_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        v.set_image(np.zeros((10, 10, 3), dtype=np.uint8))
        masks, scores, logits = v.predict_point(
            point_coords=np.array([[5, 5]]),
            point_labels=np.array([1]),
        )
        assert masks.shape == (1, 4, 4)
        fake_adapter.predict.assert_called_once()


def test_sam2_variant_extract_embedding_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        assert v.extract_embedding() == b"emb"


def test_sam2_variant_rejects_text(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_text(image_b64="", text="hat")


def test_sam2_variant_rejects_box(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_box(image_b64="", boxes=[[0, 0, 1, 1]], box_labels=[1])


def test_sam2_variant_rejects_visual(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam2_adapter", return_value=fake_adapter):
        v = Sam2Variant("sam2.1-large")
        v.load(device="cuda")
        with pytest.raises(SamCapabilityError):
            v.predict_visual(
                image_b64="", prompt_image_b64="", prompt_box=[0, 0, 1, 1]
            )


def test_sam2_variant_capability_flags():
    v = Sam2Variant("sam2.1-large")
    assert v.supports_text is False
    assert v.supports_box is False
    assert v.supports_visual is False
