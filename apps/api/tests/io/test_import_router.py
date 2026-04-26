"""HTTP-level tests for /tasks/{id}/imports."""
import io
import json
import zipfile

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
    from vaa_api.io import import_router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)

    client.post("/auth/register", json={"email": "imp@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "imp@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    return token, pid, tid


def test_yolo_import_accepts_zip(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("data.yaml", b'names: ["car"]\n')
        zf.writestr("labels/a.txt", b"0 0.5 0.5 0.1 0.1\n")
    r = client.post(
        f"/tasks/{tid}/imports?format=yolo",
        files={"file": ("y.zip", io.BytesIO(buf.getvalue()), "application/zip")},
        headers=_hdr(token),
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert "import_id" in body


def test_coco_import_accepts_json(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    coco = {"images": [], "categories": [], "annotations": []}
    r = client.post(
        f"/tasks/{tid}/imports?format=coco",
        files={"file": ("coco.json", io.BytesIO(json.dumps(coco).encode()), "application/json")},
        headers=_hdr(token),
    )
    assert r.status_code == 202


def test_yolo_import_rejects_non_zip(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/imports?format=yolo",
        files={"file": ("y.json", io.BytesIO(b"{}"), "application/json")},
        headers=_hdr(token),
    )
    assert r.status_code == 400
    body = r.json()
    # The global HTTPException handler in main.py wraps string details as {"error": ...}
    assert body.get("error") == "yolo_import_requires_zip" or body.get("detail") == "yolo_import_requires_zip"


def test_coco_import_rejects_unknown_extension(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    r = client.post(
        f"/tasks/{tid}/imports?format=coco",
        files={"file": ("x.txt", io.BytesIO(b"hi"), "text/plain")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def test_unknown_task_returns_404(db_session, monkeypatch) -> None:
    client = _client(db_session)
    from vaa_api.assets import service as assets_svc
    from vaa_api.io import import_router as router_mod
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(router_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    import uuid
    r = client.post(
        f"/tasks/{uuid.uuid4()}/imports?format=yolo",
        files={"file": ("y.zip", io.BytesIO(b"PK\x03\x04"), "application/zip")},
        headers=_hdr(token),
    )
    assert r.status_code == 404


def test_get_progress_returns_pending_without_redis(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    r = client.get(
        f"/tasks/{tid}/imports/some-id",
        headers=_hdr(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "pending"
