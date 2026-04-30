"""Tests for ``GET /sam/status`` (load-state inspection endpoint).

v3.5 Phase C — the editor polls this endpoint while the variant-switch
overlay is open. We exercise the state machine via the public surface:

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


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    p_mod._reset_load_state()
    r_mod._reset_switch_inflight_for_test()
    monkeypatch.delenv("SAM_MODEL", raising=False)
    monkeypatch.delenv("SAM_VARIANT", raising=False)
    yield
    p_mod.set_test_predictor(None)
    p_mod._set_test_session(None)
    p_mod._reset_load_state()
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

    def slow_load(variant: str) -> None:
        started.set()
        # Block until the test releases us — the status endpoint should
        # report "loading" the whole time.
        blocker.wait(timeout=2.0)

    monkeypatch.setattr(r_mod, "load_predictor", slow_load)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r.status_code == 202
    assert started.wait(timeout=1.0)

    status = _wait_for_state(client, expected=("loading",))
    assert status["state"] == "loading"
    assert status["variant"] == "sam2.1-tiny"
    assert status["job_id"]

    # Release worker so teardown is clean.
    blocker.set()


def test_status_ready_after_load_completes(monkeypatch) -> None:
    """After load_predictor finishes, /sam/status reports ``ready``."""
    finished = threading.Event()

    def fake_load(variant: str) -> None:
        # Mirror what the real load_predictor does on success.
        p_mod._set_load_state(
            kind="ready",
            variant=variant,
            loaded_at=datetime.now(timezone.utc).isoformat(),
        )
        finished.set()

    monkeypatch.setattr(r_mod, "load_predictor", fake_load)

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

    def boom(variant: str) -> None:
        raise RuntimeError("HF download failed: connection reset")

    monkeypatch.setattr(r_mod, "load_predictor", boom)

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

    def slow_load(variant: str) -> None:
        started.set()
        blocker.wait(timeout=2.0)

    monkeypatch.setattr(r_mod, "load_predictor", slow_load)

    client = _client()
    r1 = client.post("/sam/switch", json={"variant": "sam2.1-tiny"})
    assert r1.status_code == 202
    assert started.wait(timeout=1.0)

    r2 = client.post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "switch_in_progress"

    blocker.set()
