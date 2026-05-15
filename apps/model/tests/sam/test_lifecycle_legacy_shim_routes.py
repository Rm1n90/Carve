"""set_test_predictor / set_text_predictor must route through manager
via the _LegacyTestVariant aggregator."""
import pytest

from carve_model.sam.lifecycle import manager


@pytest.fixture(autouse=True)
def reset():
    yield
    manager._reset_for_tests()


def test_set_test_predictor_installs_legacy_variant():
    from carve_model.sam.predictor import set_test_predictor

    class FakePoint:
        def set_image(self, image): pass
        def predict(self, **kw): return ("m", "s", "l")
        def extract_embedding(self): return b"e"

    set_test_predictor(FakePoint())
    with manager.lease() as sam:
        m, s, l = sam.predict_point(point_coords=None, point_labels=None)
        assert m == "m"


def test_set_text_predictor_adds_text_impl():
    from carve_model.sam.predictor import set_test_predictor, set_text_predictor

    class FakePoint:
        def predict(self, **kw): return ("m", "s", "l")

    set_test_predictor(FakePoint())
    set_text_predictor(lambda **kw: [{
        "counts": "c", "size": [1, 1], "score": 0.5,
        "bbox": [0, 0, 1, 1], "polygon": []
    }])
    with manager.lease() as sam:
        rows = sam.predict_text(image_b64="b", text="t")
        assert rows[0]["score"] == 0.5


def test_set_test_predictor_none_clears():
    from carve_model.sam.predictor import set_test_predictor
    from carve_model.sam.lifecycle import SamNotReadyError

    set_test_predictor(object())
    set_test_predictor(None)
    # Test variant cleared — lease now sees production state (idle)
    with pytest.raises(SamNotReadyError):
        with manager.lease() as sam:
            sam.predict_point(point_coords=None, point_labels=None)
