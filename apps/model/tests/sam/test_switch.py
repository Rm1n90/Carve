"""HTTP-level tests for ``POST /sam/switch`` (variant hot-swap endpoint).

v3.5 Phase C — the endpoint is now non-blocking. It validates the
variant, spawns a worker thread that calls ``load_predictor``, and
returns 202 + ``{job_id, state, variant}`` immediately. Clients poll
``GET /sam/status`` until the load state machine settles.

We assert on:

- 422 on unknown variant
- 422 on missing variant (FastAPI body validation)
- 202 + job_id on success; the worker calls load_predictor with the
  requested variant
- 409 when another switch is already in flight
- error state surfaced via /sam/status when the worker raises
"""

from __future__ import annotations

import threading
import time

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
    """Poll /sam/status until ``state`` is one of ``expected`` or timeout."""
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


def test_switch_unknown_variant_returns_422() -> None:
    r = _client().post("/sam/switch", json={"variant": "totally-not-a-model"})
    assert r.status_code == 422


def test_switch_missing_variant_returns_422() -> None:
    r = _client().post("/sam/switch", json={})
    assert r.status_code == 422


def test_switch_returns_202_and_runs_load_predictor(monkeypatch) -> None:
    """202 with job_id on success; the worker calls load_predictor once."""
    calls: list[str] = []
    started = threading.Event()
    finished = threading.Event()

    def fake_load(variant: str) -> None:
        started.set()
        calls.append(variant)
        # Reflect the "ready" state on completion the same way the real
        # load_predictor does. The router's _spawn_switch wrapper also
        # records the job_id, so just flip kind→ready.
        from datetime import datetime, timezone
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
    body = r.json()
    assert body["state"] == "loading"
    assert body["variant"] == "sam2.1-small"
    assert body["job_id"]

    # Wait for the worker to complete.
    assert started.wait(timeout=2.0)
    assert finished.wait(timeout=2.0)
    assert calls == ["sam2.1-small"]

    status = _wait_for_state(client, expected=("ready",))
    assert status["state"] == "ready"
    assert status["variant"] == "sam2.1-small"


def test_switch_409_when_another_switch_in_flight(monkeypatch) -> None:
    """409 ``switch_in_progress`` on concurrent switch attempts."""
    # Block the worker indefinitely so the in-flight job stays open.
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

    # Second request while the first is still loading must 409.
    r2 = client.post("/sam/switch", json={"variant": "sam2.1-small"})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "switch_in_progress"

    # Release the worker and let it finish so teardown is clean.
    blocker.set()


def test_switch_error_state_surfaced_via_status(monkeypatch) -> None:
    """Worker raise → /sam/status reflects ``error`` with the message."""

    def boom(variant: str) -> None:
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(r_mod, "load_predictor", boom)

    client = _client()
    r = client.post("/sam/switch", json={"variant": "sam2.1-large"})
    assert r.status_code == 202

    status = _wait_for_state(client, expected=("error",))
    assert status["state"] == "error"
    assert "CUDA out of memory" in (status.get("error") or "")


def test_status_idle_when_nothing_loaded() -> None:
    r = _client().get("/sam/status")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "idle"
    # Variant defaults to the configured SAM_MODEL (or default) when
    # nothing has been loaded yet.
    assert body["variant"] is not None
    assert body["loaded_at"] is None
    assert body["error"] is None
