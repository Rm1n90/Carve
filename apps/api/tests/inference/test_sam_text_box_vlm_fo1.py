"""Phase 4 — API-side VLM-FO1 wiring tests.

Verifies that ``use_vlm_fo1`` flows correctly through the API surfaces:

  - ``POST /assets/{id}/sam/text-prompt`` (single image) — kwarg
    forwarded to model service when True, omitted when False / absent
  - ``GET /models/sam-status`` — proxies ``vlm_fo1_available`` from the
    model service so the editor can show/hide the toggle
"""

from __future__ import annotations

import io
import json

import httpx
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.inference import model_client as model_client_mod
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478"
        "DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(_tiny_png())

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _setup_asset(client, monkeypatch):
    from carve_api.assets import service as assets_svc
    from carve_api.inference import autoannotate as aa_mod

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "fo1@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "fo1@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


# --- /sam/text-prompt single asset -----------------------------------------


def test_text_prompt_does_not_forward_use_vlm_fo1_when_omitted(
    db_session, monkeypatch,
) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/text-prompt":
            seen.update(json.loads(request.content))
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "person"},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert "use_vlm_fo1" not in seen
    finally:
        model_client_mod.set_test_transport(None)


def test_text_prompt_forwards_use_vlm_fo1_true(
    db_session, monkeypatch,
) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/text-prompt":
            seen.update(json.loads(request.content))
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "person", "use_vlm_fo1": True},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert seen.get("use_vlm_fo1") is True
    finally:
        model_client_mod.set_test_transport(None)


def test_text_prompt_does_not_forward_use_vlm_fo1_false(
    db_session, monkeypatch,
) -> None:
    """Explicit false from client = omitted (route skips the kwarg)."""
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/text-prompt":
            seen.update(json.loads(request.content))
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/text-prompt",
            json={"text": "person", "use_vlm_fo1": False},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert "use_vlm_fo1" not in seen
    finally:
        model_client_mod.set_test_transport(None)


# --- /models/sam-status capability proxy -----------------------------------


class _PatchedTransportClient:
    """Stand-in for ``httpx.Client`` exposing only the methods
    ``sam_status_endpoint`` actually calls."""

    def __init__(self, handler):
        self._handler = handler

    def get(self, url):
        req = httpx.Request("GET", url)
        return self._handler(req)


class _PatchedClient:
    def __init__(self, handler):
        self._handler = handler

    def __call__(self, *a, **kw):
        return _PatchedClientCM(self._handler)


class _PatchedClientCM:
    def __init__(self, handler):
        self._client = _PatchedTransportClient(handler)

    def __enter__(self):
        return self._client

    def __exit__(self, *a):
        return None


def _patch_models_info_httpx(monkeypatch, handler) -> None:
    from carve_api.models_info import router as mi_router

    factory = _PatchedClient(handler)

    def _make_client(*a, **kw):
        return _PatchedClientCM(handler)

    monkeypatch.setattr(mi_router.httpx, "Client", _make_client)


def test_sam_status_proxies_vlm_fo1_available_true(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, _aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/status":
            return httpx.Response(
                200,
                json={
                    "state": "ready",
                    "variant": "sam3",
                    "progress_bytes": None,
                    "progress_total": None,
                    "loaded_at": "2026-05-05T00:00:00Z",
                    "error": None,
                    "job_id": None,
                    "vlm_fo1_available": True,
                },
            )
        return httpx.Response(404)

    _patch_models_info_httpx(monkeypatch, handler)

    r = client.get("/models/sam-status", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["vlm_fo1_available"] is True


def test_sam_status_defaults_vlm_fo1_available_false_when_upstream_omits(
    db_session, monkeypatch,
) -> None:
    """Pre-Phase-3 model service deployments don't return the field —
    surface as ``available=false``."""
    client = _client(db_session)
    token, _aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/status":
            return httpx.Response(
                200,
                json={
                    "state": "ready",
                    "variant": "sam3",
                    "progress_bytes": None,
                    "progress_total": None,
                    "loaded_at": "2026-05-05T00:00:00Z",
                    "error": None,
                    "job_id": None,
                },
            )
        return httpx.Response(404)

    _patch_models_info_httpx(monkeypatch, handler)

    r = client.get("/models/sam-status", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["vlm_fo1_available"] is False
