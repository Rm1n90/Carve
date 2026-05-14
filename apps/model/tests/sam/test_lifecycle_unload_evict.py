import threading
import time
from unittest.mock import MagicMock, patch

from carve_model.sam.lifecycle import SamLifecycleManager


def _load_sam2(mgr: SamLifecycleManager) -> MagicMock:
    adapter = MagicMock()
    with patch(
        "carve_model.sam.lifecycle._build_sam2_adapter",
        return_value=adapter,
    ):
        mgr.ensure_loaded("sam2.1-large")
    return adapter


def test_force_unload_drops_active():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    assert mgr.force_unload() is True
    s = mgr.status()
    assert s.kind == "idle"
    assert mgr._active is None
    assert mgr._last_used_at is None


def test_force_unload_idle_returns_false():
    mgr = SamLifecycleManager()
    assert mgr.force_unload() is False


def test_force_unload_waits_for_inflight_inference():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    inside_lease = threading.Event()
    release = threading.Event()
    unload_started = threading.Event()
    unload_done = threading.Event()

    def worker_lease():
        with mgr.lease():
            inside_lease.set()
            release.wait()

    def worker_unload():
        inside_lease.wait()
        unload_started.set()
        mgr.force_unload()
        unload_done.set()

    tl = threading.Thread(target=worker_lease)
    tu = threading.Thread(target=worker_unload)
    tl.start()
    tu.start()
    unload_started.wait()
    time.sleep(0.1)
    assert not unload_done.is_set(), "unload must wait for inflight lease"
    release.set()
    tl.join(timeout=2)
    tu.join(timeout=2)
    assert unload_done.is_set()
    assert mgr.status().kind == "idle"


def test_evict_if_idle_respects_timeout():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with patch.object(mgr, "_idle_timeout_s", return_value=60):
        assert mgr.evict_if_idle() is False
    assert mgr.status().kind == "ready"


def test_evict_if_idle_drops_when_past_timeout():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1000.0
    with patch.object(mgr, "_idle_timeout_s", return_value=60):
        assert mgr.evict_if_idle() is True
    assert mgr.status().kind == "idle"


def test_evict_if_idle_rechecks_under_lock():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1000.0

    # Wrap the real lock so we can tick _last_used_at between the pre-check
    # and the actual acquire. Python's _thread.lock disallows patching
    # acquire directly, so we proxy through an instance with a custom
    # acquire method.
    real_lock = mgr._inference_lock

    class _RaceLock:
        def acquire(self, *args, **kw):
            with mgr._load_lock:
                mgr._last_used_at = time.monotonic()
            return real_lock.acquire(*args, **kw)

        def release(self):
            return real_lock.release()

        def __enter__(self):
            self.acquire()
            return self

        def __exit__(self, *exc):
            self.release()
            return False

    mgr._inference_lock = _RaceLock()  # type: ignore[assignment]
    try:
        with patch.object(mgr, "_idle_timeout_s", return_value=60):
            assert mgr.evict_if_idle() is False
        assert mgr.status().kind == "ready"
    finally:
        mgr._inference_lock = real_lock


def test_evict_if_idle_disabled_when_timeout_zero():
    mgr = SamLifecycleManager()
    _load_sam2(mgr)
    with mgr._load_lock:
        mgr._last_used_at = time.monotonic() - 1e9
    with patch.object(mgr, "_idle_timeout_s", return_value=0):
        assert mgr.evict_if_idle() is False
