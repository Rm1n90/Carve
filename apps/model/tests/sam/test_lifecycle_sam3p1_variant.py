from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from carve_model.sam.lifecycle import Sam3p1Variant


@pytest.fixture
def fake_adapter():
    adapter = MagicMock()
    adapter._state = {}
    adapter._device = "cuda"
    adapter.predict.return_value = (
        np.zeros((1, 4, 4), dtype=bool),
        np.array([0.9]),
        np.zeros((1, 256, 256), dtype=np.float32),
    )
    return adapter


def test_sam3p1_variant_load_builds_adapter(fake_adapter):
    with patch(
        "carve_model.sam.lifecycle._build_sam3p1_adapter",
        return_value=fake_adapter,
    ) as build:
        v = Sam3p1Variant()
        v.load(device="cuda")
        build.assert_called_once_with(device="cuda")
        assert v.name == "sam3.1"
        assert v.device == "cuda"


def test_sam3p1_variant_unload_drops_adapter_refs(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        v.unload()
        assert v.cached_image_hash() is None
        assert fake_adapter._state is None
        assert fake_adapter._model is None
        assert fake_adapter._processor is None


def test_sam3p1_variant_set_image_caches_hash(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        img = np.zeros((10, 10, 3), dtype=np.uint8)
        h = v.set_image(img)
        assert isinstance(h, str) and len(h) == 64
        assert v.cached_image_hash() == h
        assert v.cached_image_shape() == (10, 10)
        fake_adapter.set_image.assert_called_once()


def test_sam3p1_variant_predict_point_delegates(fake_adapter):
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        v.set_image(np.zeros((10, 10, 3), dtype=np.uint8))
        masks, scores, logits = v.predict_point(
            point_coords=np.array([[5, 5]]),
            point_labels=np.array([1]),
        )
        assert masks.shape == (1, 4, 4)
        fake_adapter.predict.assert_called_once()


def test_sam3p1_variant_capability_flags_all_true():
    v = Sam3p1Variant()
    assert v.supports_text is True
    assert v.supports_box is True
    assert v.supports_visual is True


def test_sam3p1_variant_box_visual_not_implemented_yet(fake_adapter):
    # predict_text is migrated in Task 2.1; only box/visual remain stubbed.
    with patch("carve_model.sam.lifecycle._build_sam3p1_adapter", return_value=fake_adapter):
        v = Sam3p1Variant()
        v.load(device="cuda")
        with pytest.raises(NotImplementedError):
            v.predict_box(image_b64="", boxes=[[0, 0, 1, 1]], box_labels=[1])
        with pytest.raises(NotImplementedError):
            v.predict_visual(image_b64="", prompt_image_b64="", prompt_box=[0, 0, 1, 1])
