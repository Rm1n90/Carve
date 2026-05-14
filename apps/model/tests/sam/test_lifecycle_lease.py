import threading
import time
from unittest.mock import patch

import pytest

from carve_model.sam.lifecycle import (
    LoadState,
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


def _force_ready(mgr: SamLifecycleManager, variant: StubVariant) -> None:
    """Inject a variant directly into production-mode state."""
    with mgr._load_lock:
        mgr._active = variant  # type: ignore[assignment]
        mgr._state = LoadState.ready("stub", loaded_at="2026-05-14T00:00:00Z")
        mgr._last_used_at = time.monotonic()


def test_lease_yields_active_variant_when_ready():
    mgr = SamLifecycleManager()
    v = StubVariant()
    _force_ready(mgr, v)
    with mgr.lease() as sam:
        assert sam is v


def test_lease_raises_when_idle():
    mgr = SamLifecycleManager()
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "idle"


def test_lease_raises_when_loading():
    mgr = SamLifecycleManager()
    with mgr._load_lock:
        mgr._state = LoadState.loading("sam3.1", started_at="2026-05-14T00:00:00Z")
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "loading"


def test_lease_raises_when_error():
    mgr = SamLifecycleManager()
    with mgr._load_lock:
        mgr._state = LoadState.error_("sam3.1", "out of memory")
    with pytest.raises(SamNotReadyError) as exc:
        with mgr.lease():
            pass
    assert exc.value.state == "error"


def test_lease_ticks_last_used_on_enter_and_exit():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    with mgr._load_lock:
        mgr._last_used_at = 0.0
    with mgr.lease():
        with mgr._load_lock:
            t_inside = mgr._last_used_at
        assert t_inside > 0.0
    with mgr._load_lock:
        t_after = mgr._last_used_at
    assert t_after >= t_inside


def test_lease_serializes_two_threads():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    entered = threading.Event()
    release = threading.Event()
    result = []

    def worker_a():
        with mgr.lease():
            entered.set()
            release.wait()
        result.append("a-done")

    def worker_b():
        entered.wait()
        start = time.monotonic()
        with mgr.lease():
            elapsed = time.monotonic() - start
            result.append(("b-got-lock", elapsed))

    ta = threading.Thread(target=worker_a)
    tb = threading.Thread(target=worker_b)
    ta.start()
    tb.start()
    time.sleep(0.2)
    release.set()
    ta.join(timeout=2)
    tb.join(timeout=2)
    assert result[0] == "a-done"
    label, elapsed = result[1]
    assert label == "b-got-lock"
    assert elapsed >= 0.15


def test_lease_oom_runs_light_cleanup():
    mgr = SamLifecycleManager()
    _force_ready(mgr, StubVariant())
    cleaned = []
    with patch.object(
        mgr, "_run_cuda_cleanup_light", side_effect=lambda: cleaned.append(True)
    ):
        class FakeOOM(RuntimeError):
            pass

        with patch(
            "carve_model.sam.lifecycle._is_cuda_oom", return_value=True
        ):
            with pytest.raises(FakeOOM):
                with mgr.lease():
                    raise FakeOOM("CUDA out of memory")
    assert cleaned == [True]
