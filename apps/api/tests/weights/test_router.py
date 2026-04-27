import io

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _setup(client, monkeypatch):
    from carve_api.weights import service as svc_mod

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


def test_upload_accepts_empty_class_names(db_session, monkeypatch) -> None:
    """Phase B / v2.3: empty `class_names` is allowed.

    The frontend dialog submits `[]` and lets users manage class mapping
    via project classes — the model file's own `names` dict is read at
    inference time. See `WeightService.upload`.
    """
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
    assert r.status_code == 201
    assert r.json()["class_names"] == []


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

    # second user (member) — created via the bootstrap admin's token after lockdown.
    client.post(
        "/auth/register",
        json={"email": "intruder@x.com", "password": "hunter22"},
        headers=_hdr(token),
    )
    other = client.post("/auth/login", json={"email": "intruder@x.com", "password": "hunter22"}).json()["access_token"]
    r = client.delete(f"/weights/{wid}", headers=_hdr(other))
    assert r.status_code == 403

    # owner deletes successfully
    r = client.delete(f"/weights/{wid}", headers=_hdr(token))
    assert r.status_code == 204


def test_patch_renames_weight(db_session, monkeypatch) -> None:
    """PATCH /weights/{id} with `{name}` updates the weight name only."""
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    fake_pt = b"PK\x03\x04" + b"x" * 64
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "old-name",
            "task_kind": "detect",
            "class_names": '["car"]',
        },
        files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    p = client.patch(
        f"/weights/{wid}",
        json={"name": "new-name"},
        headers=_hdr(token),
    )
    assert p.status_code == 200, p.text
    assert p.json()["name"] == "new-name"
    # task_kind & class_names unchanged
    assert p.json()["task_kind"] == "detect"
    assert p.json()["class_names"] == ["car"]


def test_patch_forbidden_to_other_user(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid = _setup(client, monkeypatch)
    fake_pt = b"PK\x03\x04" + b"x" * 64
    r = client.post(
        f"/projects/{pid}/weights",
        data={
            "name": "owners-weight",
            "task_kind": "detect",
            "class_names": '["car"]',
        },
        files={"file": ("y.pt", io.BytesIO(fake_pt), "application/octet-stream")},
        headers=_hdr(token),
    )
    wid = r.json()["id"]
    client.post(
        "/auth/register",
        json={"email": "thief@x.com", "password": "hunter22"},
        headers=_hdr(token),
    )
    other = client.post(
        "/auth/login", json={"email": "thief@x.com", "password": "hunter22"}
    ).json()["access_token"]
    p = client.patch(
        f"/weights/{wid}",
        json={"name": "stolen"},
        headers=_hdr(other),
    )
    assert p.status_code == 403
