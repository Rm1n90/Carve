"""Tests for ``POST /models/sam-active`` (SAM variant hot-swap proxy).

Mocks the model service's ``/sam/switch`` via httpx.MockTransport so we
exercise the API router's success/422/503 mapping without touching a
real model container.
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
        json={"email": "switcher@x.com", "password": "hunter22"},
    )
    return client.post(
        "/auth/login",
        json={"email": "switcher@x.com", "password": "hunter22"},
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
    """Patch ``httpx.Client`` so the SAM-switch route uses a MockTransport.

    Returns a list that captures every Request the route fires, so
    individual tests can assert on the proxied JSON.
    """
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


def test_sam_active_post_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.post("/models/sam-active", json={"variant": "sam2.1-tiny"})
    assert r.status_code == 401


def test_sam_active_post_rejects_unknown_variant(db_session) -> None:
    client = _client(db_session)
    token = _bootstrap_admin(client)

    r = client.post(
        "/models/sam-active",
        json={"variant": "totally-not-a-variant"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422


def test_sam_active_post_proxies_to_model_and_updates_get(
    db_session, monkeypatch
) -> None:
    """Happy path: model service returns 202 + job_id; GET reflects the new variant."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/sam/switch"
        return httpx.Response(
            202,
            json={
                "job_id": "abc123",
                "state": "loading",
                "variant": "sam2.1-large",
            },
        )

    captured = _install_mock_transport(monkeypatch, handler)

    r = client.post(
        "/models/sam-active",
        json={"variant": "sam2.1-large"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 202
    body_out = r.json()
    assert body_out["variant"] == "sam2.1-large"
    assert body_out["active_variant"] == "sam2.1-large"
    assert body_out["job_id"] == "abc123"
    assert body_out["state"] == "loading"
    assert len(captured) == 1
    import json

    body = json.loads(captured[0].content)
    assert body == {"variant": "sam2.1-large"}

    # GET should now reflect the cached value
    g = client.get(
        "/models/sam-active", headers={"Authorization": f"Bearer {token}"}
    )
    assert g.status_code == 200
    assert g.json()["active"] == "sam2.1-large"


def test_sam_active_post_translates_base_plus_naming(
    db_session, monkeypatch
) -> None:
    """The API speaks ``sam2.1-base+``; the model service speaks ``sam2.1-base-plus``."""
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(req.content)
        assert body == {"variant": "sam2.1-base-plus"}
        return httpx.Response(
            202,
            json={
                "job_id": "deadbeef",
                "state": "loading",
                "variant": "sam2.1-base-plus",
            },
        )

    _install_mock_transport(monkeypatch, handler)

    r = client.post(
        "/models/sam-active",
        json={"variant": "sam2.1-base+"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 202
    # API returns the API-side spelling (so GET stays consistent)
    body_out = r.json()
    assert body_out["variant"] == "sam2.1-base+"
    assert body_out["active_variant"] == "sam2.1-base+"


def test_sam_active_post_503_when_model_service_down(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_mock_transport(monkeypatch, handler)

    r = client.post(
        "/models/sam-active",
        json={"variant": "sam2.1-tiny"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 503
    body = r.json()
    # The HTTPException handler in main.py unwraps a dict ``detail``
    # directly into the response body, so the envelope is the dict.
    assert body == {"error": "model_service_unavailable"}


def test_sam_active_post_503_when_model_service_503(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "sam_variant_load_failed"})

    _install_mock_transport(monkeypatch, handler)

    r = client.post(
        "/models/sam-active",
        json={"variant": "sam2.1-tiny"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 503
    assert r.json() == {"error": "model_service_unavailable"}


def test_sam_active_post_422_when_model_service_422(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token = _bootstrap_admin(client)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": "unknown_variant"})

    _install_mock_transport(monkeypatch, handler)

    # Use a variant the API allow-list accepts so it reaches the model service
    r = client.post(
        "/models/sam-active",
        json={"variant": "sam3"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422
