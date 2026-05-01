"""Plan 11 Task 4 — multiplex proxy endpoints on the carve api.

Covers:
- DELETE /assets/{aid}/sam-track/{sid}/objects/{oid} → proxies to the model
  service and returns 204 on success, 422 on ``tracker_not_multiplex``.
- POST /assets/{aid}/sam-track/{sid}/reset → same shape.
- POST /assets/{aid}/sam-track/{sid}/objects with ``text`` → forwards text
  to the model service in place of points/boxes.
"""
import io

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


def _mp4_placeholder() -> bytes:
    return b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(b"")

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _setup_video_asset(client, monkeypatch):
    from carve_api.assets import service as assets_svc
    from carve_api.inference import sam_track as sam_track_mod

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "mx@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "mx@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "video"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(_mp4_placeholder()), "video/mp4")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


# --- DELETE /sam-track/{sid}/objects/{oid} ---------------------------------


def test_remove_object_proxies_to_model_service(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if (
            request.method == "DELETE"
            and request.url.path == "/sam-track/S-1/objects/3"
        ):
            captured["path"] = request.url.path
            return httpx.Response(204)
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.delete(
            f"/assets/{aid}/sam-track/S-1/objects/3", headers=_hdr(token),
        )
        assert r.status_code == 204, r.text
        assert captured["path"] == "/sam-track/S-1/objects/3"
    finally:
        model_client_mod.set_test_transport(None)


def test_remove_object_propagates_422_when_not_multiplex(
    db_session, monkeypatch,
) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": "adapter_not_multiplex"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.delete(
            f"/assets/{aid}/sam-track/S-1/objects/3", headers=_hdr(token),
        )
        assert r.status_code == 422, r.text
        assert r.json()["error"] == "tracker_not_multiplex"
    finally:
        model_client_mod.set_test_transport(None)


def test_remove_object_returns_404_when_asset_missing(
    db_session, monkeypatch,
) -> None:
    client = _client(db_session)
    from carve_api.assets import service as assets_svc
    from carve_api.inference import sam_track as sam_track_mod

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "rm@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "rm@x.com", "password": "hunter22"},
    ).json()["access_token"]
    import uuid

    r = client.delete(
        f"/assets/{uuid.uuid4()}/sam-track/S-1/objects/1",
        headers=_hdr(token),
    )
    assert r.status_code == 404


# --- POST /sam-track/{sid}/reset -------------------------------------------


def test_reset_proxies_to_model_service(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/S-9/reset":
            captured["method"] = request.method
            captured["path"] = request.url.path
            return httpx.Response(204)
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/S-9/reset", headers=_hdr(token),
        )
        assert r.status_code == 204, r.text
        assert captured["method"] == "POST"
        assert captured["path"] == "/sam-track/S-9/reset"
    finally:
        model_client_mod.set_test_transport(None)


def test_reset_propagates_422_when_not_multiplex(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": "adapter_not_multiplex"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/S-9/reset", headers=_hdr(token),
        )
        assert r.status_code == 422, r.text
        assert r.json()["error"] == "tracker_not_multiplex"
    finally:
        model_client_mod.set_test_transport(None)


def test_reset_returns_404_when_asset_missing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from carve_api.assets import service as assets_svc
    from carve_api.inference import sam_track as sam_track_mod

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "rs@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "rs@x.com", "password": "hunter22"},
    ).json()["access_token"]
    import uuid

    r = client.post(
        f"/assets/{uuid.uuid4()}/sam-track/S-1/reset",
        headers=_hdr(token),
    )
    assert r.status_code == 404


# --- text prompt forwarding -----------------------------------------------


def test_add_object_with_text_forwards_text_to_model(
    db_session, monkeypatch,
) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/S-T/objects":
            import json

            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"obj_ids": [1, 2], "frame_idx": 0})
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/S-T/objects",
            json={"frame_idx": 0, "text": "person"},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"obj_ids": [1, 2], "frame_idx": 0}
        assert captured["body"]["text"] == "person"
        assert "points" not in captured["body"]
        assert "boxes" not in captured["body"]
    finally:
        model_client_mod.set_test_transport(None)
