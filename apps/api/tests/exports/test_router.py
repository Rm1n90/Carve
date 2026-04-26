import io

from fastapi.testclient import TestClient

from vaa_api.deps import get_db
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


def _setup(client, monkeypatch):
    from vaa_api.assets import service as assets_svc
    from vaa_api.exports import router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "ex@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "ex@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    car = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()
    return token, pid, tid, car["id"]


def test_create_export_returns_id_and_pending(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, car_id = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/exports",
        json={
            "format": "yolo",
            "class_remap": {car_id: {"export_id": 0, "name": "vehicle"}},
            "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
            "include_images": False,
        },
        headers=_hdr(token),
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert "export_id" in body

    # GET should report pending status (no Redis worker actually ran)
    r2 = client.get(f"/tasks/{tid}/exports/{body['export_id']}", headers=_hdr(token))
    assert r2.status_code == 200
    snap = r2.json()
    assert snap["status"] == "pending"
    assert snap["download_url"] is None


def test_export_unknown_id_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, _ = _setup(client, monkeypatch)
    import uuid
    r = client.get(f"/tasks/{tid}/exports/{uuid.uuid4()}", headers=_hdr(token))
    assert r.status_code == 404


def test_unknown_task_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from vaa_api.assets import service as assets_svc
    from vaa_api.exports import router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/tasks/{uuid.uuid4()}/exports",
        json={"format": "yolo", "class_remap": {}, "splits": {"train": 0.8, "val": 0.1, "test": 0.1}, "include_images": False},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_invalid_format_rejected_by_validation(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, _ = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/exports",
        json={"format": "bogus", "class_remap": {}, "splits": {"train": 0.8, "val": 0.1, "test": 0.1}, "include_images": False},
        headers=_hdr(token),
    )
    assert r.status_code == 422
