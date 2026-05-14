import numpy as np
import pytest

from carve_model.sam.lifecycle import (
    SamCapabilityError,
    _LegacyTestVariant,
)


def test_legacy_variant_with_only_point_impl():
    lv = _LegacyTestVariant()

    class FakePoint:
        def predict(self, **kw): return ("masks", "scores", "logits")

    lv._point_impl = FakePoint()
    masks, scores, logits = lv.predict_point(point_coords=None, point_labels=None)
    assert masks == "masks"
    with pytest.raises(SamCapabilityError):
        lv.predict_text(image_b64="", text="")


def test_legacy_variant_aggregates_multiple_impls():
    lv = _LegacyTestVariant()

    class FakePoint:
        def predict(self, **kw): return ("masks", "scores", "logits")

    lv._point_impl = FakePoint()
    lv._text_impl = lambda **kw: [{"score": 1.0}]
    assert lv.predict_text(image_b64="", text="hat") == [{"score": 1.0}]
    assert lv.predict_point(point_coords=None, point_labels=None)[0] == "masks"


def test_legacy_variant_capability_flags_track_impls():
    lv = _LegacyTestVariant()
    assert lv.supports_text is False
    lv._text_impl = lambda **kw: []
    assert lv.supports_text is True


def test_legacy_variant_set_image_returns_dummy_hash():
    lv = _LegacyTestVariant()
    h = lv.set_image(np.zeros((1, 1, 3), dtype=np.uint8))
    assert isinstance(h, str)
    assert lv.cached_image_hash() == h
