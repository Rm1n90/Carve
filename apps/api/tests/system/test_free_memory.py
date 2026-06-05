# Armin Mehri — mehri.armin@gmail.com
#
# POST /system/free-memory — admin-only "Free memory" button. Orchestrates the
# model-service unloads (SAM + FO1 + YOLO/YOLOE reclaim), trims the api heap,
# and reports the host RAM + VRAM freed. No DB needed: we override the admin
# auth dep and monkeypatch the model-client + psutil.
from types import SimpleNamespace

from fastapi.testclient import TestClient

import carve_api.inference.model_client as mc
import carve_api.system.router as sysrouter
from carve_api.auth.models import UserRole
from carve_api.deps import get_current_admin_user, get_current_user
from carve_api.main import create_app

MB = 1024 * 1024


def _mock_model_service(monkeypatch) -> None:
    monkeypatch.setattr(
        mc,
        "sam_unload",
        lambda which="all": {
            "evicted": ["image", "tracker"],
            "sessions_released": 2,
            "gpu_freed_mb": 1500,
        },
    )
    monkeypatch.setattr(
        mc,
        "sam_vlm_fo1_unload_detailed",
        lambda: {"evicted": True, "gpu_freed_mb": 6000},
    )
    monkeypatch.setattr(
        mc,
        "model_reclaim",
        lambda: {
            "yolo_evicted": ["w1"],
            # The model service returns YoloeKey str literals ("text"/"pf").
            "yoloe_evicted": ["text", "pf"],
            "gpu_freed_mb": 1000,
            "malloc_trimmed": True,
        },
    )


def test_free_memory_orchestrates_and_reports_freed(monkeypatch) -> None:
    app = create_app()
    app.dependency_overrides[get_current_admin_user] = lambda: SimpleNamespace(
        id="u1", role=UserRole.admin
    )
    _mock_model_service(monkeypatch)
    # Host RAM: available rises 1000 MB → 3000 MB across the two samples.
    avails = iter([1000 * MB, 3000 * MB])
    monkeypatch.setattr(
        sysrouter.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(
            available=next(avails), total=16000 * MB, percent=42.0
        ),
    )

    r = TestClient(app).post("/system/free-memory")
    assert r.status_code == 200
    body = r.json()
    assert body["ram_freed_mb"] == 2000
    assert body["ram_available_before_mb"] == 1000
    assert body["ram_available_after_mb"] == 3000
    # freed must equal after − before exactly (no truncation drift).
    assert (
        body["ram_available_after_mb"] - body["ram_available_before_mb"]
        == body["ram_freed_mb"]
    )
    assert body["ram_total_mb"] == 16000
    assert body["vram_freed_mb"] == 1500 + 6000 + 1000
    assert body["malloc_trimmed"] is True
    for evicted in (
        "sam:image",
        "sam:tracker",
        "fo1",
        "yolo:w1",
        "yoloe:text",
        "yoloe:pf",
    ):
        assert evicted in body["models_evicted"], evicted
    # Regression: a YoloeKey str must NOT be exploded into characters
    # (the bug was list("text") → ["t","e","x","t"] → "yoloe:t/e/x/t").
    assert not any("/" in m for m in body["models_evicted"])


def test_free_memory_clamps_freed_at_zero_when_ram_drops(monkeypatch) -> None:
    # Available memory can fall during the call (other processes grow); the
    # reported freed number must clamp at 0 rather than go negative.
    app = create_app()
    app.dependency_overrides[get_current_admin_user] = lambda: SimpleNamespace(
        id="u1", role=UserRole.admin
    )
    _mock_model_service(monkeypatch)
    avails = iter([5000 * MB, 4000 * MB])
    monkeypatch.setattr(
        sysrouter.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(
            available=next(avails), total=16000 * MB, percent=70.0
        ),
    )
    body = TestClient(app).post("/system/free-memory").json()
    assert body["ram_freed_mb"] == 0


def test_free_memory_requires_admin(monkeypatch) -> None:
    app = create_app()
    # A non-admin (member) must be rejected by the admin gate.
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id="u2", role=UserRole.member
    )
    r = TestClient(app).post("/system/free-memory")
    assert r.status_code == 403
