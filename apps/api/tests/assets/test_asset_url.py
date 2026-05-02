import io

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session):
    app = create_app()
    def _override():
        try: yield db_session
        finally: db_session.rollback()
    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def _setup_with_asset(client, monkeypatch):
    from carve_api.assets import service as svc_mod

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def ensure_bucket(self): pass
        def put_object(self, *a, **k): pass
        def get_object(self, key): import io; return io.BytesIO(b"")
        def remove_object(self, key): pass
        def presigned_get(self, key, **k): return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "g@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "g@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    png = bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    aid = r.json()["id"]
    return token, pid, tid, aid


def test_get_asset_returns_presigned_url(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid = _setup_with_asset(client, monkeypatch)
    r = client.get(f"/assets/{aid}", headers=_hdr(token))
    assert r.status_code == 200
    body = r.json()
    assert "url" in body
    assert body["url"].startswith("https://fake/assets/")
    assert body["asset"]["id"] == aid


def test_delete_asset_owner_or_admin_only(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, aid = _setup_with_asset(client, monkeypatch)

    # Register a second user (member) via the bootstrap admin's token, then login.
    client.post(
        "/auth/register",
        json={"email": "intruder@x.com", "password": "hunter22"},
        headers=_hdr(token),
    )
    other = client.post(
        "/auth/login", json={"email": "intruder@x.com", "password": "hunter22"}
    ).json()["access_token"]
    r = client.delete(f"/assets/{aid}", headers=_hdr(other))
    # Plan-13 Phase 7 Task 2 — non-member sees 404 (TaskNotFound mask)
    # rather than 403, so we never leak project existence to anyone
    # outside the project. Workspace-admin still gets owner shortcut.
    assert r.status_code == 404

    # Owner can delete
    r = client.delete(f"/assets/{aid}", headers=_hdr(token))
    assert r.status_code == 204

    # Subsequent GET is 404
    r = client.get(f"/assets/{aid}", headers=_hdr(token))
    assert r.status_code == 404
