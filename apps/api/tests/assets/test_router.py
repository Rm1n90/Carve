import io

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session):
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _setup(client):
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    return token, pid, tid


def test_upload_image_creates_asset(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    token, pid, tid = _setup(client)
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("image.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["mime"] == "image/png"
    assert body["kind"] == "image"


def test_list_assets_for_task(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)
    client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    r = client.get(f"/tasks/{tid}/assets", headers=_hdr(token))
    assert r.status_code == 200
    assert len(r.json()) == 1


def test_duplicate_asset_returns_409(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)
    png = _tiny_png()
    client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("b.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 409


def test_mime_mismatch_returns_400(db_session, monkeypatch) -> None:
    from vaa_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)  # image task
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42"), "video/mp4")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )


class _FakeStorage:
    @classmethod
    def from_settings(cls): return cls()
    def ensure_bucket(self): pass
    def put_object(self, *a, **k): pass
    def get_object(self, key): import io; return io.BytesIO(b"")
    def remove_object(self, key): pass
    def presigned_get(self, key, **k): return f"https://fake/{key}"
