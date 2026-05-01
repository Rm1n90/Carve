"""Tests for the Phase 5 review workflow (plan-09 task-02).

Covers single + batch review endpoints, status filter on the task-scoped
list endpoint, and the auto-reset behaviour on the existing edit path.
"""

from __future__ import annotations

import io
import uuid

from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session):
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(b"")

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


_PNG_BYTES = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA"
    "63000000000200015C8B59FA0000000049454E44AE426082"
)


def _setup_admin_project(client, monkeypatch):
    """Bootstrap the first user (admin) plus a project, task, class, asset
    and frame so each test can attach annotations without re-uploading."""
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "rev_admin@x.com", "password": "hunter22"})
    token = client.post(
        "/auth/login", json={"email": "rev_admin@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "car", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]
    aid_resp = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_PNG_BYTES), "image/png")},
        headers=_hdr(token),
    ).json()
    aid = aid_resp["id"]
    fid = client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]
    return token, pid, tid, cid, fid


def _create_member(client, admin_token: str, email: str) -> str:
    client.post(
        "/auth/members",
        json={"email": email, "password": "hunter22", "role": "member"},
        headers=_hdr(admin_token),
    )
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _demote_to_viewer(client, admin_token: str, email: str) -> str:
    members = client.get("/auth/members", headers=_hdr(admin_token)).json()
    target = next(u for u in members if u["email"] == email)
    client.patch(
        f"/auth/members/{target['id']}/role",
        json={"role": "viewer"},
        headers=_hdr(admin_token),
    )
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _make_annotation(client, token: str, tid: str, cid: str, fid: str, x: int = 1) -> dict:
    r = client.post(
        f"/tasks/{tid}/annotations",
        json={
            "frame_id": fid,
            "class_id": cid,
            "kind": "bbox",
            "geometry": {"kind": "bbox", "x": x, "y": x, "w": x + 5, "h": x + 5},
        },
        headers=_hdr(token),
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_accept_happy_path(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    ann = _make_annotation(client, token, tid, cid, fid, x=2)
    original_geometry = ann["geometry"]
    me = client.get("/auth/me", headers=_hdr(token)).json()

    r = client.post(
        f"/annotations/{ann['id']}/review",
        json={"decision": "accept", "note": "looks good"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert body["reviewed_by_id"] == me["id"]
    assert body["reviewed_at"] is not None
    assert body["prev_geometry"] == original_geometry


def test_reject_happy_path(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    ann = _make_annotation(client, token, tid, cid, fid, x=3)
    me = client.get("/auth/me", headers=_hdr(token)).json()

    r = client.post(
        f"/annotations/{ann['id']}/review",
        json={"decision": "reject"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "rejected"
    assert body["reviewed_by_id"] == me["id"]
    assert body["reviewed_at"] is not None
    assert body["prev_geometry"] == ann["geometry"]


def test_viewer_role_forbidden(db_session, monkeypatch) -> None:
    """Viewers are read-only and cannot review."""
    client = _client(db_session)
    admin_token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    ann = _make_annotation(client, admin_token, tid, cid, fid, x=4)

    _create_member(client, admin_token, "viewer@x.com")
    viewer_token = _demote_to_viewer(client, admin_token, "viewer@x.com")

    r = client.post(
        f"/annotations/{ann['id']}/review",
        json={"decision": "accept"},
        headers=_hdr(viewer_token),
    )
    assert r.status_code == 403


def test_batch_review_mixed(db_session, monkeypatch) -> None:
    """Mixed ids: real ones the caller can access, plus a missing uuid.

    Under the current single-workspace ACL all members can access every
    task, so the access-denied path is exercised via missing ids — the
    spec's "skipped covers ids the user can't access; do NOT 404"
    guarantee is verified by checking the missing id is silently
    counted as skipped instead of bubbling up a 404.
    """
    client = _client(db_session)
    token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    a1 = _make_annotation(client, token, tid, cid, fid, x=5)
    a2 = _make_annotation(client, token, tid, cid, fid, x=6)
    missing = str(uuid.uuid4())

    r = client.post(
        "/annotations/batch:review",
        json={"ids": [a1["id"], a2["id"], missing], "decision": "accept"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reviewed"] == 2
    assert body["skipped"] == 1


def test_status_filter_on_task_list(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    proposed = _make_annotation(client, token, tid, cid, fid, x=7)
    to_accept = _make_annotation(client, token, tid, cid, fid, x=8)

    client.post(
        f"/annotations/{to_accept['id']}/review",
        json={"decision": "accept"},
        headers=_hdr(token),
    )

    r_prop = client.get(
        f"/tasks/{tid}/annotations?status=proposed", headers=_hdr(token)
    )
    assert r_prop.status_code == 200
    ids_prop = [a["id"] for a in r_prop.json()]
    assert ids_prop == [proposed["id"]]

    r_acc = client.get(
        f"/tasks/{tid}/annotations?status=accepted", headers=_hdr(token)
    )
    assert r_acc.status_code == 200
    ids_acc = [a["id"] for a in r_acc.json()]
    assert ids_acc == [to_accept["id"]]


def test_status_filter_invalid_value_422(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, *_ = _setup_admin_project(client, monkeypatch)
    bad_tid = str(uuid.uuid4())
    r = client.get(
        f"/tasks/{bad_tid}/annotations?status=banana", headers=_hdr(token)
    )
    assert r.status_code == 422


def test_edit_resets_status_preserves_prev_geometry(db_session, monkeypatch) -> None:
    """accept -> PATCH geometry -> status reverts; reviewed_at/by cleared;
    prev_geometry stays as the snapshot taken at accept-time."""
    client = _client(db_session)
    token, pid, tid, cid, fid = _setup_admin_project(client, monkeypatch)
    ann = _make_annotation(client, token, tid, cid, fid, x=9)
    accepted = client.post(
        f"/annotations/{ann['id']}/review",
        json={"decision": "accept"},
        headers=_hdr(token),
    ).json()
    snapshot = accepted["prev_geometry"]

    new_geometry = {"kind": "bbox", "x": 50, "y": 60, "w": 70, "h": 80}
    r = client.patch(
        f"/annotations/{ann['id']}",
        json={"geometry": new_geometry},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "proposed"
    assert body["reviewed_by_id"] is None
    assert body["reviewed_at"] is None
    assert body["prev_geometry"] == snapshot
    assert body["geometry"]["x"] == 50


def test_batch_review_501_ids_returns_422(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, *_ = _setup_admin_project(client, monkeypatch)

    too_many = [str(uuid.uuid4()) for _ in range(501)]
    r = client.post(
        "/annotations/batch:review",
        json={"ids": too_many, "decision": "accept"},
        headers=_hdr(token),
    )
    assert r.status_code == 422

    # Exact-cap (500 ids) is accepted: all skipped because none exist.
    at_cap = [str(uuid.uuid4()) for _ in range(500)]
    r2 = client.post(
        "/annotations/batch:review",
        json={"ids": at_cap, "decision": "accept"},
        headers=_hdr(token),
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body["reviewed"] == 0
    assert body["skipped"] == 500
