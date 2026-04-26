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


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key): return io.BytesIO(_tiny_png())
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"


def _setup_asset(client, monkeypatch):
    from vaa_api.assets import service as assets_svc
    from vaa_api.inference import autoannotate as aa_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "sam@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "sam@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    return token, aid


def test_sam_encode_returns_image_hash(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/encode":
            return httpx.Response(200, json={
                "image_hash": "deadbeef" * 4,
                "shape": [1, 1],
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(f"/assets/{aid}/sam/encode", headers=_hdr(token))
        assert r.status_code == 200
        assert r.json()["image_hash"] == "deadbeef" * 4
        assert r.json()["shape"] == [1, 1]
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_forwards_points_and_labels(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/sam/decode":
            import json
            body = json.loads(request.content)
            seen.update(body)
            return httpx.Response(200, json={
                "counts": "0,2,2,2,10",
                "size": [4, 4],
                "score": 0.88,
            })
        return httpx.Response(404)

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "deadbeef" * 4,
                "points": [[10, 10], [20, 20]],
                "labels": [1, 0],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["counts"] == "0,2,2,2,10"
        assert body["score"] == 0.88
        assert seen["points"] == [[10, 10], [20, 20]]
        assert seen["labels"] == [1, 0]
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_409_when_embedding_missing(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "embedding_not_loaded"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "x" * 32,
                "points": [[1, 2]],
                "labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 409
        assert r.json()["error"] == "sam_embedding_missing"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_decode_502_on_model_error(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, aid = _setup_asset(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    model_client_mod.set_test_transport(httpx.MockTransport(handler))
    try:
        r = client.post(
            f"/assets/{aid}/sam/decode",
            json={
                "image_hash": "x" * 32,
                "points": [[1, 2]],
                "labels": [1],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 502
        assert r.json()["error"] == "sam_model_failed"
    finally:
        model_client_mod.set_test_transport(None)


def test_sam_unknown_asset_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from vaa_api.assets import service as assets_svc
    from vaa_api.inference import autoannotate as aa_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(aa_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(f"/assets/{uuid.uuid4()}/sam/encode", headers=_hdr(token))
    assert r.status_code == 404
