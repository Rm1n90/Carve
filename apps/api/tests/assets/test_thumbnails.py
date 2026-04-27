"""End-to-end tests for the v2.4 thumbnail + pagination + filter contract.

Each test sets up a project + task + a small set of image assets and
exercises one of the new endpoints (``GET /tasks/:tid/assets`` with
filters, ``GET /tasks/:tid/assets/count``, ``GET /assets/:id/thumbnail``).

The MinIO client is faked so tests don't depend on a running storage
backend; presigned URLs are deterministic strings the assertions can
check.
"""
from __future__ import annotations

import io

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):  # pragma: no cover - trivial
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(b"")

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _client(db_session):
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _tiny_png() -> bytes:
    return bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63"
        "000000000200015C8B59FA0000000049454E44AE426082"
    )


def _setup(client, monkeypatch, *, email: str = "thumb@x.com"):
    """Register a user, create a project + image task, return ids."""
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    return token, pid, tid


def _upload_png(client, token, tid, name: str) -> str:
    """Upload a single PNG (with a per-name suffix for unique hashes) and return its asset id."""
    suffix = name.encode().rjust(8, b"\x00")
    png = _tiny_png() + suffix
    r = client.post(
        f"/tasks/{tid}/assets",
        files={"file": (name, io.BytesIO(png), "image/png")},
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _make_class(client, token, pid: str) -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


# ---------------------------------------------------------------------------
# 1) Paginated list returns thumbnail_url for each item
# ---------------------------------------------------------------------------


def test_list_assets_includes_thumbnail_url_falling_back_to_original(
    db_session, monkeypatch
) -> None:
    """Without a generated thumbnail key, image assets fall back to the
    original presigned URL so the UI never sees a missing image."""
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    aid = _upload_png(client, token, tid, "first.png")

    r = client.get(f"/tasks/{tid}/assets?limit=10&offset=0", headers=_hdr(token))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["limit"] == 10
    assert body["offset"] == 0
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["id"] == aid
    assert item["thumbnail_url"] is not None
    assert item["thumbnail_url"].startswith("https://fake/assets/")


# ---------------------------------------------------------------------------
# 2) /assets/:id/thumbnail redirect / 404
# ---------------------------------------------------------------------------


def test_get_asset_thumbnail_returns_302_to_presigned_url(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch)
    aid = _upload_png(client, token, tid, "with-thumb.png")

    from carve_api.assets.models import Asset
    db_session.get(Asset, aid).thumbnail_minio_key = "assets/zzz/thumb-200.jpg"
    db_session.flush()

    r = client.get(
        f"/assets/{aid}/thumbnail", headers=_hdr(token), follow_redirects=False
    )
    assert r.status_code == 302
    assert r.headers["location"] == "https://fake/assets/zzz/thumb-200.jpg"


def test_get_asset_thumbnail_404_when_video_without_poster(db_session, monkeypatch) -> None:
    """Video assets without a generated poster have no thumbnail URL — the
    endpoint must return 404 so clients can show a placeholder.
    """
    from carve_api.assets import service as svc_mod
    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)

    client = _client(db_session)
    client.post("/auth/register", json={"email": "v@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "v@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "PV"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "TV", "kind": "video"}, headers=_hdr(token)
    ).json()["id"]
    # Construct a video asset directly via the ORM so we don't depend on a
    # real MP4 round-trip path in tests.
    from carve_api.assets.models import Asset, AssetKind
    a = Asset(
        task_id=tid,
        kind=AssetKind.video,
        xxh3_128="vidhash",
        mime="video/mp4",
        size_bytes=10,
        original_name="clip.mp4",
        frames=0,
    )
    db_session.add(a)
    db_session.flush()

    r = client.get(
        f"/assets/{a.id}/thumbnail", headers=_hdr(token), follow_redirects=False
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# 3) Status filter: annotated returns only annotated assets
# ---------------------------------------------------------------------------


def test_list_assets_filter_by_annotated_status(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch, email="status@x.com")
    cid = _make_class(client, token, pid)
    aid_annotated = _upload_png(client, token, tid, "annot.png")
    aid_empty = _upload_png(client, token, tid, "empty.png")

    # Look up the frame_id auto-created for the annotated asset and attach
    # a bbox annotation through the public API.
    from carve_api.assets.models import Frame
    from sqlalchemy import select

    import uuid

    frame_id = db_session.execute(
        select(Frame.id).where(Frame.asset_id == uuid.UUID(aid_annotated))
    ).scalar_one()
    r = client.post(
        f"/tasks/{tid}/annotations",
        json={
            "class_id": cid,
            "kind": "bbox",
            "frame_id": str(frame_id),
            "geometry": {"kind": "bbox", "x": 1, "y": 2, "w": 3, "h": 4},
        },
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text

    r = client.get(f"/tasks/{tid}/assets?status=annotated", headers=_hdr(token))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert {it["id"] for it in body["items"]} == {aid_annotated}

    r = client.get(f"/tasks/{tid}/assets?status=unannotated", headers=_hdr(token))
    body = r.json()
    assert body["total"] == 1
    assert {it["id"] for it in body["items"]} == {aid_empty}


# ---------------------------------------------------------------------------
# 4) Count endpoint returns total + annotated + unannotated breakdown
# ---------------------------------------------------------------------------


def test_assets_count_endpoint_returns_breakdown(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch, email="count@x.com")
    cid = _make_class(client, token, pid)
    aid_annot = _upload_png(client, token, tid, "a.png")
    _upload_png(client, token, tid, "b.png")
    _upload_png(client, token, tid, "c.png")

    from carve_api.assets.models import Frame
    from sqlalchemy import select
    import uuid

    frame_id = db_session.execute(
        select(Frame.id).where(Frame.asset_id == uuid.UUID(aid_annot))
    ).scalar_one()
    client.post(
        f"/tasks/{tid}/annotations",
        json={
            "class_id": cid,
            "kind": "bbox",
            "frame_id": str(frame_id),
            "geometry": {"kind": "bbox", "x": 0, "y": 0, "w": 1, "h": 1},
        },
        headers=_hdr(token),
    )

    r = client.get(f"/tasks/{tid}/assets/count", headers=_hdr(token))
    assert r.status_code == 200
    body = r.json()
    assert body == {"total": 3, "annotated": 1, "unannotated": 2}


# ---------------------------------------------------------------------------
# 5) Search by filename (q=)
# ---------------------------------------------------------------------------


def test_list_assets_filter_by_filename_search(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch, email="search@x.com")
    _upload_png(client, token, tid, "cat.png")
    _upload_png(client, token, tid, "dog.png")
    _upload_png(client, token, tid, "catdog.png")

    r = client.get(f"/tasks/{tid}/assets?q=cat", headers=_hdr(token))
    body = r.json()
    assert body["total"] == 2
    names = {it["original_name"] for it in body["items"]}
    assert names == {"cat.png", "catdog.png"}


# ---------------------------------------------------------------------------
# 6) Pagination: limit + offset slice the result set
# ---------------------------------------------------------------------------


def test_list_assets_pagination_slices_results(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid = _setup(client, monkeypatch, email="page@x.com")
    for i in range(5):
        _upload_png(client, token, tid, f"file-{i}.png")

    r = client.get(f"/tasks/{tid}/assets?limit=2&offset=0", headers=_hdr(token))
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 2

    r = client.get(f"/tasks/{tid}/assets?limit=2&offset=4", headers=_hdr(token))
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 1
