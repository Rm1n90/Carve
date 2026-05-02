"""Audit log tests (Plan-13 Phase 7 Task 3).

Covers:
  1. ``record(...)`` writes a row with the expected shape; metadata round-trips.
  2. ``record(...)`` swallows on a synthetic flush failure and returns None.
  3. ``GET /projects/{pid}/audit`` -- ordering, cursor pagination, action filter.
  4. ACL: project members of all roles can read; non-members get 404/403.
  5. Side-effect: review accept and retrain submit both fire audit rows.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from carve_api.audit import service as audit_service
from carve_api.audit.actions import (
    ANNOTATION_ACCEPTED,
    ANNOTATIONS_BATCH_REVIEWED,
    RETRAIN_SUBMITTED,
)
from carve_api.audit.models import AuditEvent
from carve_api.deps import get_db
from carve_api.main import create_app


_PNG_BYTES = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA"
    "63000000000200015C8B59FA0000000049454E44AE426082"
)


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


def _client(db_session):
    app = create_app()

    # NOTE: do NOT rollback in the override. The outer ``db_session``
    # fixture is connection-scoped with savepoint isolation, and it
    # already cleans up at teardown. Rolling back here would drop rows
    # the test seeded between requests, breaking cursor pagination.
    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _bootstrap(client, monkeypatch):
    """Register first user (admin) + project + task + class + frame."""
    from carve_api.assets import service as svc_mod

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post(
        "/auth/register",
        json={"email": "audit_admin@x.com", "password": "hunter22"},
    )
    token = client.post(
        "/auth/login",
        json={"email": "audit_admin@x.com", "password": "hunter22"},
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "Audit-P"}, headers=_hdr(token)
    ).json()["id"]
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
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_PNG_BYTES), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    fid = client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]
    return token, pid, tid, cid, fid


def _make_annotation(client, token, tid, cid, fid, x=1):
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


# ---------------------------------------------------------------------------
# 1. record(...) writes the expected row
# ---------------------------------------------------------------------------


def test_record_writes_row_and_metadata_roundtrips(db_session) -> None:
    target = uuid.uuid4()
    metadata = {"task_id": str(uuid.uuid4()), "decision": "accept", "n": 7}

    # actor_id and project_id left None to avoid FK setup; the recorder
    # treats both as nullable. Round-trip the rest.
    ev = audit_service.record(
        db_session,
        actor_id=None,
        action="annotation.accepted",
        target_type="annotation",
        target_id=target,
        project_id=None,
        summary="annotation.accepted annotation foo",
        metadata=metadata,
    )

    assert ev is not None
    assert ev.action == "annotation.accepted"
    assert ev.target_id == target
    assert ev.actor_id is None
    assert ev.project_id is None
    assert ev.metadata_ == metadata


# ---------------------------------------------------------------------------
# 2. record(...) swallows failures
# ---------------------------------------------------------------------------


def test_record_swallows_flush_failure(db_session, monkeypatch) -> None:
    """Synthetic ``flush()`` failure: record() must return None, not raise."""

    def _boom(*a, **k):
        raise RuntimeError("simulated audit insert failure")

    monkeypatch.setattr(db_session, "flush", _boom)

    out = audit_service.record(
        db_session,
        actor_id=None,
        action="annotation.accepted",
        target_type="annotation",
        target_id=None,
        project_id=None,
        summary="should not crash",
        metadata={"k": "v"},
    )
    assert out is None


# ---------------------------------------------------------------------------
# 3. GET endpoint — ordering, cursor pagination, action filter
# ---------------------------------------------------------------------------


def test_list_project_audit_orders_desc_and_paginates(
    db_session, monkeypatch
) -> None:
    client = _client(db_session)
    token, pid, *_ = _bootstrap(client, monkeypatch)

    now = datetime.now(timezone.utc)
    for i in range(5):
        ev = AuditEvent(
            actor_id=None,
            action=(
                "annotation.accepted" if i % 2 == 0 else "annotation.rejected"
            ),
            target_type="annotation",
            target_id=None,
            project_id=uuid.UUID(pid),
            summary=f"event-{i}",
            metadata_={"i": i},
            occurred_at=now - timedelta(minutes=10 - i),  # i=4 newest
        )
        db_session.add(ev)
    db_session.flush()

    r1 = client.get(f"/projects/{pid}/audit?limit=3", headers=_hdr(token))
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    summaries1 = [it["summary"] for it in body1["items"]]
    assert summaries1 == ["event-4", "event-3", "event-2"]
    assert body1["next_cursor"] is not None

    r2 = client.get(
        f"/projects/{pid}/audit?limit=3&cursor={body1['next_cursor']}",
        headers=_hdr(token),
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    summaries2 = [it["summary"] for it in body2["items"]]
    assert summaries2 == ["event-1", "event-0"]
    assert body2["next_cursor"] is None

    r3 = client.get(
        f"/projects/{pid}/audit?action=annotation.accepted",
        headers=_hdr(token),
    )
    assert r3.status_code == 200, r3.text
    summaries3 = [it["summary"] for it in r3.json()["items"]]
    assert summaries3 == ["event-4", "event-2", "event-0"]


# ---------------------------------------------------------------------------
# 4. ACL: members read; non-members blocked
# ---------------------------------------------------------------------------


def test_audit_acl_non_member_blocked(db_session, monkeypatch) -> None:
    client = _client(db_session)
    admin_token, pid, *_ = _bootstrap(client, monkeypatch)

    # Create the outsider via the admin-only members endpoint (the
    # public /auth/register path is gated to first-user-only). The
    # outsider has a User row but NO project_members row for ``pid``.
    client.post(
        "/auth/members",
        json={"email": "outsider@x.com", "password": "hunter22", "role": "member"},
        headers=_hdr(admin_token),
    )
    outsider_token = client.post(
        "/auth/login",
        json={"email": "outsider@x.com", "password": "hunter22"},
    ).json()["access_token"]

    r = client.get(f"/projects/{pid}/audit", headers=_hdr(outsider_token))
    # Non-members get NotProjectMember (403) or ProjectNotFound (404)
    # depending on the role check ordering.
    assert r.status_code in (403, 404), r.text


def test_audit_acl_member_can_read(db_session, monkeypatch) -> None:
    client = _client(db_session)
    admin_token, pid, *_ = _bootstrap(client, monkeypatch)

    r = client.get(f"/projects/{pid}/audit", headers=_hdr(admin_token))
    assert r.status_code == 200, r.text
    assert "items" in r.json()


# ---------------------------------------------------------------------------
# 5. Side-effect: review accept + batch + retrain submit fire audit events
# ---------------------------------------------------------------------------


def test_review_accept_records_audit_event(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, cid, fid = _bootstrap(client, monkeypatch)
    ann = _make_annotation(client, token, tid, cid, fid, x=2)

    r = client.post(
        f"/annotations/{ann['id']}/review",
        json={"decision": "accept"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text

    audit = client.get(
        f"/projects/{pid}/audit?action={ANNOTATION_ACCEPTED}",
        headers=_hdr(token),
    ).json()
    items = audit["items"]
    assert len(items) >= 1
    top = items[0]
    assert top["action"] == ANNOTATION_ACCEPTED
    assert top["target_id"] == ann["id"]
    assert top["metadata"]["decision"] == "accept"
    assert top["metadata"]["task_id"] == tid


def test_batch_review_records_summary_event(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, _, tid, cid, fid = _bootstrap(client, monkeypatch)
    a1 = _make_annotation(client, token, tid, cid, fid, x=5)
    a2 = _make_annotation(client, token, tid, cid, fid, x=6)

    r = client.post(
        "/annotations/batch:review",
        json={"ids": [a1["id"], a2["id"]], "decision": "accept"},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["reviewed"] == 2

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == ANNOTATIONS_BATCH_REVIEWED)
        .all()
    )
    assert any(
        ev.metadata_ is not None
        and ev.metadata_.get("reviewed") == 2
        and ev.metadata_.get("decision") == "accept"
        for ev in rows
    )


def test_retrain_submit_records_audit_event(db_session, monkeypatch) -> None:
    client = _client(db_session)
    token, pid, tid, *_ = _bootstrap(client, monkeypatch)

    r = client.post(
        f"/tasks/{tid}/retrain-yolo",
        json={"epochs": 1, "imgsz": 640, "include_proposed": False},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]

    audit = client.get(
        f"/projects/{pid}/audit?action={RETRAIN_SUBMITTED}",
        headers=_hdr(token),
    ).json()
    items = audit["items"]
    assert len(items) >= 1
    top = items[0]
    assert top["action"] == RETRAIN_SUBMITTED
    md = top["metadata"]
    assert md["job_id"] == job_id
    assert md["epochs"] == 1
    assert md["imgsz"] == 640
    assert md["include_proposed"] is False
