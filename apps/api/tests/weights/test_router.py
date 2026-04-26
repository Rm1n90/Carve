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


def _setup(client, monkeypatch):
    from vaa_api.weights import service as svc_mod

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def ensure_bucket(self): pass
        def put_object(self, *a, **k): pass
        def get_object(self, key): return io.BytesIO(b"")
        def remove_object(self, key): pass
        def presigned_get(self, key, **k): return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "wo@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "wo@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    return token, pid


def test_upload_and_list(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    fake_pt = b"PK\x03\x04" + b"x" * 1024  # 1 KiB faux .pt
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "yolo11n-detect",
            "task_kind": "detect",
            "class_names": '["car","truck"]',
        },
        files={"file": ("yolo11n.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "yolo11n-detect"
    assert r.json()["class_names"] == ["car", "truck"]

    rl = client.get(f"/projects/{pid}/weights", headers=_hdr(token))
    assert rl.status_code == 200
    assert len(rl.json()) == 1


def test_upload_rejects_non_pt(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "fake",
            "task_kind": "detect",
            "class_names": '["car"]',
        },
        files={"file": ("yolo11n.zip", io.BytesIO(b"PK\x03\x04" + b"x" * 32), "application/zip")},
        headers=_hdr(token),
    )
    assert r.status_code == 400
    assert r.json()["error"] == "weight_invalid"


def test_upload_rejects_empty_class_names(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "fake",
            "task_kind": "detect",
            "class_names": "[]",
        },
        files={"file": ("y.pt", io.BytesIO(b"PK\x03\x04" + b"x" * 32), "application/octet-stream")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def test_upload_rejects_bad_json_class_names(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "fake",
            "task_kind": "detect",
            "class_names": "not-json",
        },
        files={"file": ("y.pt", io.BytesIO(b"PK\x03\x04" + b"x" * 32), "application/octet-stream")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def test_delete_only_owner_or_admin(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    fake_pt = b"PK\x03\x04" + b"x" * 64
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "y",
            "task_kind": "detect",
            "class_names": '["car"]',
        },
        files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    )
    wid = r.json()["id"]

    # second user (member) tries to delete
    client.post("/auth/register", json={"email": "intruder@x.com", "password": "hunter22"})
    other = client.post("/auth/login", json={"email": "intruder@x.com", "password": "hunter22"}).json()["access_token"]
    r = client.delete(f"/weights/{wid}", headers=_hdr(other))
    assert r.status_code == 403

    # owner deletes successfully
    r = client.delete(f"/weights/{wid}", headers=_hdr(token))
    assert r.status_code == 204
