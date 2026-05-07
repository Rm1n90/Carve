"""HTTP-layer tests for the /devices/* router."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from carve_model import device_prefs, devices, devices_router


@pytest.fixture(autouse=True)
def isolated_prefs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Per-test isolated prefs file so writes don't leak between tests."""
    target = tmp_path / "device_prefs.json"
    monkeypatch.setenv("CARVE_DEVICE_PREFS_PATH", str(target))
    device_prefs._reset_for_tests(path=str(target))
    yield target
    device_prefs._reset_for_tests()


@pytest.fixture()
def fixed_probe(monkeypatch: pytest.MonkeyPatch) -> list[devices.DeviceInfo]:
    """Pin probe_devices() output to a deterministic two-GPU + cpu host."""
    probe = [
        devices.DeviceInfo(
            id="cuda:0", kind="cuda", name="FakeGPU 0",
            available=True, total_mb=24_000, free_mb=20_000,
        ),
        devices.DeviceInfo(
            id="cuda:1", kind="cuda", name="FakeGPU 1",
            available=True, total_mb=24_000, free_mb=22_000,
        ),
        devices.DeviceInfo(
            id="cpu", kind="cpu", name="CPU", available=True,
            total_mb=0, free_mb=0,
        ),
    ]
    monkeypatch.setattr(devices, "probe_devices", lambda: probe)
    # The router imports the symbol by name, so patch it there too.
    monkeypatch.setattr(devices_router, "probe_devices", lambda: probe)
    return probe


@pytest.fixture()
def app(fixed_probe: list[devices.DeviceInfo]) -> FastAPI:
    a = FastAPI()
    a.include_router(devices_router.router)
    return a


def test_status_lists_devices_and_models(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.get("/devices/status")
    assert r.status_code == 200
    body = r.json()
    ids = [d["id"] for d in body["devices"]]
    assert ids == ["cuda:0", "cuda:1", "cpu"]
    assert body["recommended"] == "cuda:1"  # higher free
    kinds = {m["kind"] for m in body["models"]}
    assert kinds == {"sam", "yolo", "yoloe"}
    assert body["min_free_mb"]["sam"] >= 1024
    # All start at "auto".
    for m in body["models"]:
        assert m["preference"] == "auto"


def test_set_preference_specific_cuda_honoured(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.post("/devices/preference", json={"kind": "yoloe", "device": "cuda:0"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "yoloe"
    assert body["preference"] == "cuda:0"
    assert body["fallback_used"] is False
    assert body["resolution"]["device"] == "cuda:0"

    # Persisted: subsequent /status reflects the pick.
    s = client.get("/devices/status").json()
    yoloe = next(m for m in s["models"] if m["kind"] == "yoloe")
    assert yoloe["preference"] == "cuda:0"


def test_set_preference_unavailable_falls_back(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.post("/devices/preference", json={"kind": "yolo", "device": "cuda:99"})
    assert r.status_code == 200
    body = r.json()
    assert body["fallback_used"] is True
    assert "cuda:99" in body["reason"]
    assert body["resolution"]["device"] == "cuda:1"  # recommended


def test_set_preference_auto_clears(app: FastAPI) -> None:
    client = TestClient(app)
    client.post("/devices/preference", json={"kind": "sam", "device": "cuda:0"})
    client.post("/devices/preference", json={"kind": "sam", "device": "auto"})
    s = client.get("/devices/status").json()
    sam = next(m for m in s["models"] if m["kind"] == "sam")
    assert sam["preference"] == "auto"


def test_set_preference_rejects_unknown_kind(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.post("/devices/preference", json={"kind": "xyz", "device": "cpu"})
    assert r.status_code == 422  # Pydantic literal validation


def test_sam_reload_returns_resolved_device(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    """/devices/sam/reload should call force_evict_predictor and report
    the currently resolved SAM device.

    We inject a stub module into ``sys.modules`` so the route's lazy
    import resolves to our fake without triggering the heavy real
    predictor module (which has 3.10+ syntax that the host CPython
    might not support).
    """
    import sys
    import types

    calls: list[Any] = []

    fake_mod = types.ModuleType("carve_model.sam.predictor")

    def fake_evict() -> bool:
        calls.append("evict")
        return True

    fake_mod.force_evict_predictor = fake_evict  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "carve_model.sam.predictor", fake_mod)

    client = TestClient(app)
    client.post("/devices/preference", json={"kind": "sam", "device": "cuda:0"})
    r = client.post("/devices/sam/reload")
    assert r.status_code == 200
    body = r.json()
    assert calls == ["evict"]
    assert body["evicted"] is True
    assert body["device"] == "cuda:0"
    assert body["fallback_used"] is False


def test_status_reflects_min_free_thresholds(app: FastAPI) -> None:
    """The thresholds returned to the client must match the constants the
    resolver uses; the UI relies on this to disable infeasible options."""
    client = TestClient(app)
    body = client.get("/devices/status").json()
    assert body["min_free_mb"]["sam"] == devices.MIN_FREE_MB_DEFAULTS["sam"]
    assert body["min_free_mb"]["yoloe"] == devices.MIN_FREE_MB_DEFAULTS["yoloe"]
    assert body["min_free_mb"]["yolo"] == devices.MIN_FREE_MB_DEFAULTS["yolo"]
