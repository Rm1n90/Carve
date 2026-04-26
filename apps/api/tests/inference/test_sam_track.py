import io

import httpx
from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.inference import model_client as model_client_mod
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _mp4_placeholder() -> bytes:
    # minimal mp4 ftyp box that passes the AssetService mime check (image task accepts only image kinds though,
    # so the asset task must be 'video' for this test).
    return b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key): return io.BytesIO(b"")
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"


def _setup_video_asset(client, monkeypatch):
    from vaa_api.assets import service as assets_svc
    from vaa_api.inference import sam_track as sam_track_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "tr@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "tr@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "video"}, headers=_hdr(token)).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(_mp4_placeholder()), "video/mp4")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


def test_track_start_returns_session_id(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/start":
            return httpx.Response(200, json={
                "session_id": "S-1", "mask_at_start": {"counts": "1", "size": [1, 1]},
            })
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/start",
            json={"frame_idx": 0, "points": [[10, 20]], "labels": [1]},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert r.json()["session_id"] == "S-1"
    finally:
        model_client_mod.set_test_transport(None)


def test_track_step_returns_steps(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/step"):
            return httpx.Response(200, json={
                "steps": [
                    {"frame_idx": 0, "counts": "0,2,2", "size": [2, 2], "score": 1.0},
                    {"frame_idx": 1, "counts": "0,1,3", "size": [2, 2], "score": 1.0},
                ],
            })
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/S-1/step?frames=2",
            headers=_hdr(token),
        )
        assert r.status_code == 200
        assert len(r.json()["steps"]) == 2
    finally:
        model_client_mod.set_test_transport(None)


def test_track_step_404_when_session_missing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "session_not_found"})
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/missing/step",
            headers=_hdr(token),
        )
        assert r.status_code == 404
    finally:
        model_client_mod.set_test_transport(None)


def test_track_release(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.delete(
            f"/assets/{aid}/sam-track/S-1",
            headers=_hdr(token),
        )
        assert r.status_code == 204
    finally:
        model_client_mod.set_test_transport(None)


def test_track_unknown_asset_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from vaa_api.assets import service as assets_svc
    from vaa_api.inference import sam_track as sam_track_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/assets/{uuid.uuid4()}/sam-track/start",
        json={"frame_idx": 0, "points": [[1, 1]], "labels": [1]},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_track_start_accepts_empty_points_for_multi_object_workflow(db_session, monkeypatch) -> None:
    """Multi-object: start() can open an empty session (objects added via /objects)."""
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/start":
            return httpx.Response(200, json={
                "session_id": "S-empty", "mask_at_start": {"counts": "", "size": [0, 0]},
            })
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/start",
            json={"frame_idx": 0, "points": [], "labels": []},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert r.json()["session_id"] == "S-empty"
    finally:
        model_client_mod.set_test_transport(None)


def test_track_start_passes_text_through(db_session, monkeypatch) -> None:
    """SAM 3 text prompt: /start should forward `text` to the model service."""
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/start":
            import json
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={
                "session_id": "S-3", "mask_at_start": {"counts": "", "size": [0, 0]},
            })
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/start",
            json={"frame_idx": 0, "points": [], "labels": [], "text": "person"},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert captured["body"].get("text") == "person"
    finally:
        model_client_mod.set_test_transport(None)


def test_add_object_endpoint_returns_404_when_asset_missing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from vaa_api.assets import service as assets_svc
    from vaa_api.inference import sam_track as sam_track_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(sam_track_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "ao@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "ao@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/assets/{uuid.uuid4()}/sam-track/S-1/objects",
        json={"frame_idx": 0, "obj_id": 1, "points": [[1, 1]], "labels": [1]},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_add_object_endpoint_proxies_to_model_service(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam-track/S-1/objects":
            import json
            captured["body"] = json.loads(request.content.decode())
            captured["path"] = request.url.path
            return httpx.Response(200, json={"obj_id": 1, "frame_idx": 0})
        return httpx.Response(404)
    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam-track/S-1/objects",
            json={"frame_idx": 0, "obj_id": 1, "points": [[10, 20]], "labels": [1]},
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"obj_id": 1, "frame_idx": 0}
        assert captured["path"] == "/sam-track/S-1/objects"
        assert captured["body"]["obj_id"] == 1
        assert captured["body"]["points"] == [[10, 20]]
        assert captured["body"]["labels"] == [1]
    finally:
        model_client_mod.set_test_transport(None)


def test_add_object_endpoint_validates_points_labels_match(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)
    r = client.post(
        f"/assets/{aid}/sam-track/S-1/objects",
        json={"frame_idx": 0, "obj_id": 1, "points": [[1, 1], [2, 2]], "labels": [1]},
        headers=_hdr(token),
    )
    assert r.status_code == 422


def test_add_object_endpoint_requires_points_or_boxes(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_video_asset(client, monkeypatch)
    r = client.post(
        f"/assets/{aid}/sam-track/S-1/objects",
        json={"frame_idx": 0, "obj_id": 1, "points": [], "labels": [], "boxes": []},
        headers=_hdr(token),
    )
    assert r.status_code == 422
