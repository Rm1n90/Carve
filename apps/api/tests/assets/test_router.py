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


def _setup(client):
    client.post("/auth/register", json={"email": "u@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "u@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    return token, pid, tid


def test_upload_image_creates_asset(db_session, monkeypatch) -> None:
    from carve_api.assets import service as svc_mod
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
    from carve_api.assets import service as svc_mod
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
    body = r.json()
    assert body["total"] == 1
    assert len(body["items"]) == 1


def test_list_assets_accepts_limit_5000(db_session, monkeypatch) -> None:
    """v3.7.1 — backend page-limit cap must accept limit=5000 to match the
    frontend assetsApi.listForTask bump in v3.7. Previously the cap was
    500, causing 422s and breaking thumbnails / count / keyboard nav for
    tasks with >500 assets."""
    from carve_api.assets import service as svc_mod
    from carve_api.assets.router import _MAX_PAGE_LIMIT

    assert _MAX_PAGE_LIMIT >= 5000, (
        f"expected _MAX_PAGE_LIMIT >= 5000, got {_MAX_PAGE_LIMIT}"
    )

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, _pid, tid = _setup(client)
    r = client.get(f"/tasks/{tid}/assets?limit=5000", headers=_hdr(token))
    assert r.status_code == 200, r.text


def test_duplicate_asset_returns_409(db_session, monkeypatch) -> None:
    from carve_api.assets import service as svc_mod
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


def test_get_asset_image_returns_frame_id(db_session, monkeypatch) -> None:
    """v2.5.1 — GET /assets/{id} for an image asset must return the
    primary frame_id so the editor can scope annotations per asset."""
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    token, _pid, tid = _setup(client)
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    aid = r.json()["id"]

    r = client.get(f"/assets/{aid}", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "frame_id" in body, "response missing frame_id"
    frame_id = body["frame_id"]
    assert isinstance(frame_id, str) and frame_id, (
        "image asset frame_id must be a non-empty UUID string"
    )

    # Verify it matches the single Frame row created on upload.
    from carve_api.assets.models import Asset, Frame
    asset = db_session.get(Asset, aid)
    assert asset is not None
    frames = db_session.query(Frame).filter(Frame.asset_id == asset.id).all()
    assert len(frames) == 1
    assert frame_id == str(frames[0].id)


def test_get_asset_video_frame_id_null(db_session, monkeypatch) -> None:
    """v2.5.1 — GET /assets/{id} for a video asset must return frame_id
    null. Video frames are enumerated via the dedicated frames endpoint;
    a single primary frame_id doesn't make sense for video."""
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    client.post("/auth/register", json={"email": "v@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "v@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "PV"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "TV", "kind": "video"},
        headers=_hdr(token),
    ).json()["id"]
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42"), "video/mp4")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    aid = r.json()["id"]

    r = client.get(f"/assets/{aid}", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "frame_id" in body
    assert body["frame_id"] is None, "video asset frame_id must be null"


def test_mime_mismatch_returns_400(db_session, monkeypatch) -> None:
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client = _client(db_session)
    token, pid, tid = _setup(client)  # image task
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("v.mp4", io.BytesIO(b"\x00\x00\x00\x18ftypmp42"), "video/mp4")},
        headers=_hdr(token),
    )
    assert r.status_code == 400


def test_default_upload_cap_is_at_least_fifty_gib() -> None:
    """The single-asset ceiling must default to >= 50 GiB so multi-GB source
    videos upload without the old 1 GiB ``asset_too_large`` rejection."""
    from carve_api.assets.service import _max_upload_bytes

    assert _max_upload_bytes() >= 50 * 1024 * 1024 * 1024


def test_upload_over_configured_cap_returns_413(db_session, monkeypatch) -> None:
    """Files larger than the configured cap are rejected with 413
    ``asset_too_large`` — but the check is now on the spooled size, not on a
    full in-memory read, so it stays memory-safe."""
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    # Shrink the ceiling to a few bytes so a tiny PNG trips it.
    monkeypatch.setattr(svc_mod, "_max_upload_bytes", lambda: 8)
    client = _client(db_session)
    token, _pid, tid = _setup(client)
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("big.png", io.BytesIO(_tiny_png()), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 413, r.text
    assert r.json()["detail"] == "asset_too_large"


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
