import io
import zipfile

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
    client.post("/auth/register", json={"email": "z@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "z@x.com", "password": "hunter22"}).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)).json()["id"]
    return token, pid, tid


def _tiny_png(payload_byte: int = 0xAA) -> bytes:
    # 1x1 PNG - 4 minor variations to bypass dedup; payload byte is included via a trailing
    # custom chunk so each call returns different bytes.
    base = bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
    )
    # tack on a custom non-critical chunk so the file hash changes
    return base + bytes([0, 0, 0, 1, ord("v"), ord("a"), ord("a"), 0, payload_byte, 0, 0, 0, 0])


def _build_zip(images: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in images:
            zf.writestr(name, body)
    return buf.getvalue()


def test_zip_upload_extracts_three_pngs(db_session, monkeypatch) -> None:
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
    client = _client(db_session)
    token, pid, tid = _setup(client)

    archive = _build_zip([
        ("a.png", _tiny_png(0x10)),
        ("b.png", _tiny_png(0x20)),
        ("c.png", _tiny_png(0x30)),
    ])
    r = client.post(
        f"/tasks/{tid}/assets:zip",
        files={"file": ("imgs.zip", io.BytesIO(archive), "application/zip")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    assert len(r.json()) == 3


def test_zip_upload_skips_non_image_members(db_session, monkeypatch) -> None:
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
    client = _client(db_session)
    token, pid, tid = _setup(client)

    archive = _build_zip([
        ("a.png", _tiny_png(0x40)),
        ("readme.txt", b"not an image"),
        ("b.png", _tiny_png(0x50)),
    ])
    r = client.post(
        f"/tasks/{tid}/assets:zip",
        files={"file": ("mixed.zip", io.BytesIO(archive), "application/zip")},
        headers=_hdr(token),
    )
    assert r.status_code == 201
    assert len(r.json()) == 2
