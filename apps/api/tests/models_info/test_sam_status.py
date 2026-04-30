"""Tests for ``GET /models/sam-status`` (SAM load-state proxy).

v3.5 Phase C — the editor polls this endpoint while the variant-switch
overlay is open. We mock the model service's ``/sam/status`` via
``httpx.MockTransport`` and assert on the API-side response shape:

- proxy passes through state/variant/progress fields
- ``model_service_unreachable`` is synthesised when the model container
  is unreachable so the overlay can dismiss instead of spinning
- the endpoint requires authentication (matches /sam-active)
"""

from __future__ import annotations

import contextlib
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.models_info import router as models_info_router


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _bootstrap_admin(client: TestClient) -> str:
    client.post(
        "/auth/register",
        json={"email": "status@x.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "status@x.com", "password": "hunter22"},
    ).json()["access_token"]


@pytest.fixture(autouse=True)
def _reset_active_variant():
    """Drop the module-level cache between tests."""
    models_info_router._active_sam_variant = None  # type: ignore[attr-defined]
    yield
    models_info_router._active_sam_variant = None  # type: ignore[attr-defined]


def _install_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler,
) -> list[httpx.Request]:
    """Patch ``httpx.Client`` so the SAM-status route uses a MockTransport."""
    captured: list[httpx.Request] = []

    def recording_handler(req: httpx.Request) -> httpx.Response:
        captured.append(req)
        return handler(req)

    transport = httpx.MockTransport(recording_handler)

    real_client = httpx.Client

    @contextlib.contextmanager
    def _patched(*args: Any, **kwargs: Any):
        kwargs["transport"] = transport
        with real_client(*args, **kwargs) as c:
            yield c

    monkeypatch.setattr(
        models_info_router.httpx,
        "Client",
        _patched,
    )
    return captured


def test_sam_status_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.get("/models/sam-status")
    assert r.status_code == 401


def test_sam_status_proxies_model_service_state(db_session, monkeypatch) -> None:
    """Happy path: model service returns ``ready`` state; API mirrors it."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/sam/status"
        return httpx.Response(
            200,
            json={
                "state": "ready",
                "variant": "sam2.1-large",
                "progress_bytes": None,
                "progress_total": None,
                "loaded_at": "2026-04-30T12:34:56+00:00",
                "error": None,
                "job_id": None,
            },
        )

    _install_mock_transport(monkeypatch, handler)

    r = client.get(
        "/models/sam-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "ready"
    assert body["variant"] == "sam2.1-large"
    assert body["loaded_at"] == "2026-04-30T12:34:56+00:00"
    assert body["error"] is None


def test_sam_status_translates_base_plus_naming(db_session, monkeypatch) -> None:
    """The model service speaks ``sam2.1-base-plus``; the API maps it to ``sam2.1-base+``."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "state": "ready",
                "variant": "sam2.1-base-plus",
                "progress_bytes": None,
                "progress_total": None,
                "loaded_at": None,
                "error": None,
                "job_id": None,
            },
        )

    _install_mock_transport(monkeypatch, handler)

    r = client.get(
        "/models/sam-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json()["variant"] == "sam2.1-base+"


def test_sam_status_loading_state_with_progress(db_session, monkeypatch) -> None:
    """Loading state with byte-progress fields passed through unchanged."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "state": "loading",
                "variant": "sam2.1-large",
                "progress_bytes": 1_234_567,
                "progress_total": 2_400_000_000,
                "loaded_at": None,
                "error": None,
                "job_id": "abc123",
            },
        )

    _install_mock_transport(monkeypatch, handler)

    r = client.get(
        "/models/sam-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "loading"
    assert body["progress_bytes"] == 1_234_567
    assert body["progress_total"] == 2_400_000_000
    assert body["job_id"] == "abc123"


def test_sam_status_synthesises_error_when_model_service_unreachable(
    db_session, monkeypatch
) -> None:
    """Connection error → synthetic ``error`` state with ``model_service_unreachable``."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_mock_transport(monkeypatch, handler)

    r = client.get(
        "/models/sam-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "error"
    assert body["error"] == "model_service_unreachable"
    assert body["variant"] is None


def test_sam_status_synthesises_error_when_model_service_5xx(
    db_session, monkeypatch
) -> None:
    """5xx from the model service → synthetic ``error`` state."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "down"})

    _install_mock_transport(monkeypatch, handler)

    r = client.get(
        "/models/sam-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "error"
    assert body["error"] == "model_service_unreachable"
