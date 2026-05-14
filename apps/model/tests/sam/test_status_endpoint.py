"""Tests for ``GET /sam/status`` (load-state inspection endpoint).

v3.5 Phase C — the editor polls this endpoint while the variant-switch
overlay is open. Task 3.6 moves the canonical state to
``lifecycle.manager.status()`` (no legacy fallback). We exercise the
state machine via the public surface:

- idle initially (no predictor loaded)
- loading state while a switch worker is in flight
- ready state after the worker completes
- error state when the worker raises
- 409 ``switch_in_progress`` on concurrent switch attempts
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.sam import predictor as p_mod
from carve_model.sam import router as r_mod
from carve_model.sam.lifecycle import LoadState, manager


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    p_mod._reset_load_state()
    manager._reset_for_tests()
    r_mod._reset_switch_inflight_for_test()
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    yield
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    p_mod._reset_load_state()
    manager._reset_for_tests()
    r_mod._reset_switch_inflight_for_test()


def _client() -> TestClient:
    return TestClient(create_app())


def _wait_for_state(
    client: TestClient,
    *,
    expected: tuple[str, ...],
    timeout: float = 2.0,
) -> dict:
    """Poll /sam/status until ``state`` is in ``expected`` or timeout."""
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        r = client.get("/sam/status")
        last = r.json()
        if last.get("state") in expected:
            return last
        time.sleep(0.02)
    raise AssertionError(
        f"timed out waiting for state in {expected!r}; last={last!r}",
    )


def test_status_idle_initially() -> None:
    r = _client().get("/sam/status")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "idle"
    assert body["variant"] is not None  # Falls back to configured default
    assert body["loaded_at"] is None
    assert body["error"] is None


def test_status_loading_during_switch(monkeypatch) -> None:
    """While the switch worker is running, /sam/status reports ``loading``."""
    blocker = threading.Event()
    started = threading.Event()

    def slow_ensure_loaded(variant: str, *, device: str | None = None) -> None:
        # Mirror the real ensure_loaded: flip to loading before the
        # expensive build step, then block. The status endpoint should
        # report "loading" the whole time.
        manager._state = LoadState.loading(
            variant,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        started.set()
        blocker.wait(timeout=2.0)

    monkeypatch.setattr(manager, "ensure_loaded", slow_ensure_loaded)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r.status_code == 202
    assert started.wait(timeout=1.0)

    status = _wait_for_state(client, expected=("loading",))
    assert status["state"] == "loading"
    assert status["variant"] == "sam2.1-tiny"
    # job_id is no longer carried in the manager's LoadState; the wire
    # field is preserved (as None) for backwards-compatibility (Task 3.6).
    assert status["job_id"] is None

    # Release worker so teardown is clean.
    blocker.set()


def test_status_ready_after_load_completes(monkeypatch) -> None:
    """After ensure_loaded finishes, /sam/status reports ``ready``."""
    finished = threading.Event()

    def fake_ensure_loaded(variant: str, *, device: str | None = None) -> None:
        # Mirror what the real ensure_loaded does on success.
        manager._state = LoadState.ready(
            variant,
            loaded_at=datetime.now(timezone.utc).isoformat(),
        )
        finished.set()

    monkeypatch.setattr(manager, "ensure_loaded", fake_ensure_loaded)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r.status_code == 202
    assert finished.wait(timeout=2.0)

    status = _wait_for_state(client, expected=("ready",))
    assert status["state"] == "ready"
    assert status["variant"] == "sam2.1-small"
    assert status["loaded_at"] is not None


def test_status_error_on_failed_load(monkeypatch) -> None:
    """When the worker raises, /sam/status reports ``error`` with the message."""

    def boom(variant: str, *, device: str | None = None) -> None:
        # Real ensure_loaded writes error state before raising
        # SamLoadError; mirror that here.
        manager._state = LoadState.error_(variant, "HF download failed: connection reset")
        raise RuntimeError("HF download failed: connection reset")

    monkeypatch.setattr(manager, "ensure_loaded", boom)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-large"})
    assert r.status_code == 202

    status = _wait_for_state(client, expected=("error",))
    assert status["state"] == "error"
    assert "HF download failed" in (status.get("error") or "")


def test_switch_409_on_concurrent_attempt(monkeypatch) -> None:
    """A second switch while another is in flight returns 409 ``switch_in_progress``."""
    blocker = threading.Event()
    started = threading.Event()

    def slow_ensure_loaded(variant: str, *, device: str | None = None) -> None:
        manager._state = LoadState.loading(
            variant,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        started.set()
        blocker.wait(timeout=2.0)

    monkeypatch.setattr(manager, "ensure_loaded", slow_ensure_loaded)

    client = _client()
    r1 = client.post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r1.status_code == 202
    assert started.wait(timeout=1.0)

    r2 = client.post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "switch_in_progress"

    blocker.set()


def test_status_progress_fields_are_none_post_task_36(monkeypatch) -> None:
    """Task 3.6 — progress_bytes/progress_total are constant None.

    The legacy HF-download progress sentinel (progress_bytes=0,
    progress_total=-1) was wired into ``predictor._LOAD_STATE``, which is
    no longer read by /sam/status. The wire shape preserves the fields
    (spec goal #6) but they never populate. This test pins the new
    contract so the editor's overlay can rely on None as a safe default.
    """
    blocker = threading.Event()
    started = threading.Event()

    def slow_ensure_loaded(variant: str, *, device: str | None = None) -> None:
        manager._state = LoadState.loading(
            variant,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        started.set()
        blocker.wait(timeout=2.0)

    monkeypatch.setattr(manager, "ensure_loaded", slow_ensure_loaded)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r.status_code == 202
    assert started.wait(timeout=1.0)

    body = client.get("/sam/status").json()
    assert body["state"] == "loading"
    assert body["progress_bytes"] is None
    assert body["progress_total"] is None

    blocker.set()


def test_set_load_progress_preserves_other_state_fields() -> None:
    """``_set_load_progress`` is a partial-update — kind, variant,
    job_id, etc. must survive a progress write.
    """
    p_mod._set_load_state(
        kind="loading",
        variant="sam2.1-large",
        job_id="job-abc",
    )
    p_mod._set_load_progress(progress_bytes=0, progress_total=-1)
    state = p_mod.get_load_state()
    assert state.kind == "loading"
    assert state.variant == "sam2.1-large"
    assert state.job_id == "job-abc"
    assert state.progress_bytes == 0
    assert state.progress_total == -1
    p_mod._set_load_progress(progress_bytes=None, progress_total=None)
    state = p_mod.get_load_state()
    assert state.progress_bytes is None
    assert state.progress_total is None
    # Other fields untouched.
    assert state.kind == "loading"
    assert state.variant == "sam2.1-large"
    assert state.job_id == "job-abc"
