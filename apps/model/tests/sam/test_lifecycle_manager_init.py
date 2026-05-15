import pytest

from carve_model.sam.lifecycle import (
    SamLifecycleManager,
    SamNotReadyError,
)


class StubVariant:
    name = "stub"
    device = None
    build_key = ("stub", "fp32", "sdpa")
    supports_text = False
    supports_box = False
    supports_visual = False

    def load(self, device): pass
    def unload(self): pass
    def set_image(self, image): return "h"
    def cached_image_hash(self): return "h"
    def cached_image_shape(self): return (1, 1)
    def extract_embedding(self): return None
    def set_prev_logits(self, low_res_logits, n_points): pass
    def get_prev_logits(self): return (None, 0)
    def predict_point(self, **kw): return (None, None, None)
    def predict_text(self, **kw): raise NotImplementedError
    def predict_box(self, **kw): raise NotImplementedError
    def predict_visual(self, **kw): raise NotImplementedError


def test_manager_initial_state_is_idle():
    mgr = SamLifecycleManager()
    s = mgr.status()
    assert s.kind == "idle"
    assert s.variant is None


def test_manager_install_test_variant_overrides_lease():
    mgr = SamLifecycleManager()
    stub = StubVariant()
    mgr.install_test_variant(stub)  # type: ignore[arg-type]
    with mgr.lease() as sam:
        assert sam is stub


def test_manager_install_test_variant_none_clears():
    mgr = SamLifecycleManager()
    mgr.install_test_variant(StubVariant())  # type: ignore[arg-type]
    mgr.install_test_variant(None)
    with pytest.raises(SamNotReadyError):
        with mgr.lease():
            pass


def test_manager_reset_for_tests_clears_everything():
    mgr = SamLifecycleManager()
    mgr.install_test_variant(StubVariant())  # type: ignore[arg-type]
    mgr._reset_for_tests()
    assert mgr.status().kind == "idle"
    with pytest.raises(SamNotReadyError):
        with mgr.lease():
            pass


def test_remembered_variant_initially_none():
    mgr = SamLifecycleManager()
    assert mgr.remembered_variant() is None
