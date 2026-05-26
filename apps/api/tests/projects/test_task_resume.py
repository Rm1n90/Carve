import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from carve_api.projects.schemas import TaskResumeStatus


def test_resume_schema_accepts_populated_payload() -> None:
    asset_id = uuid.uuid4()
    frame_id = uuid.uuid4()
    ts = datetime(2026, 5, 26, 16, 4, tzinfo=timezone.utc)
    s = TaskResumeStatus(
        last_asset_id=asset_id,
        last_frame_id=frame_id,
        annotated_assets=350,
        total_assets=1000,
        last_activity_at=ts,
    )
    assert s.last_asset_id == asset_id
    assert s.annotated_assets == 350


def test_resume_schema_accepts_empty_payload() -> None:
    s = TaskResumeStatus(
        last_asset_id=None,
        last_frame_id=None,
        annotated_assets=0,
        total_assets=0,
        last_activity_at=None,
    )
    assert s.last_asset_id is None
    assert s.last_activity_at is None


def test_resume_schema_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        TaskResumeStatus(
            last_asset_id=None,
            last_frame_id=None,
            annotated_assets=-1,
            total_assets=10,
            last_activity_at=None,
        )


from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _register_and_login(client, email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_resume_returns_empty_payload_when_no_annotations(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "resume-r1@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    r = client.get(f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token))

    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "last_asset_id": None,
        "last_frame_id": None,
        "annotated_assets": 0,
        "total_assets": 0,
        "last_activity_at": None,
    }


def test_resume_requires_auth(db_session) -> None:
    client = _client(db_session)
    fake_pid = "00000000-0000-0000-0000-000000000000"
    fake_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{fake_pid}/tasks/{fake_tid}/resume")
    assert r.status_code == 401


def test_resume_404_for_unknown_task(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "resume-r2@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    bogus_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{pid}/tasks/{bogus_tid}/resume", headers=_hdr(token))
    assert r.status_code == 404


def test_resume_403_for_non_member(db_session) -> None:
    client = _client(db_session)
    owner_token = _register_and_login(client, "resume-owner@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(owner_token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(owner_token),
    ).json()["id"]

    # Second user must be registered by an authenticated user (invite pattern).
    client.post(
        "/auth/register",
        json={"email": "resume-outsider@x.com", "password": "hunter22"},
        headers=_hdr(owner_token),
    )
    outsider_token = client.post(
        "/auth/login",
        json={"email": "resume-outsider@x.com", "password": "hunter22"},
    ).json()["access_token"]

    r = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(outsider_token)
    )
    assert r.status_code == 403


import uuid as _uuid

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.projects.models import Class, ProjectMember


def _make_class(db_session, project_id, idx: int = 0, name: str = "obj"):
    cls = Class(
        id=_uuid.uuid4(),
        project_id=project_id,
        idx=idx,
        name=name,
        color="#ffffff",
    )
    db_session.add(cls)
    db_session.flush()
    return cls


def _make_asset_with_frame(db_session, task_id, idx_suffix: str = "a"):
    asset = Asset(
        id=_uuid.uuid4(),
        task_id=task_id,
        kind=AssetKind.image,
        xxh3_128=_uuid.uuid4().hex,  # unique per asset to satisfy uq_assets_task_hash
        mime="image/jpeg",
        size_bytes=1234,
        original_name=f"image_{idx_suffix}.jpg",
    )
    db_session.add(asset)
    db_session.flush()
    frame = Frame(
        id=_uuid.uuid4(),
        asset_id=asset.id,
        idx=0,
    )
    db_session.add(frame)
    db_session.flush()
    return asset, frame


def _make_bbox(db_session, task_id, frame_id, class_id, user_id):
    ann = Annotation(
        id=_uuid.uuid4(),
        task_id=task_id,
        frame_id=frame_id,
        class_id=class_id,
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
        created_by=user_id,
    )
    db_session.add(ann)
    db_session.flush()
    return ann


def test_resume_returns_latest_asset_and_correct_counts(db_session) -> None:
    """User annotates three assets. Resume points at the most recent
    one and counts distinct assets correctly."""
    client = _client(db_session)
    token = _register_and_login(client, "happy@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    me = client.get("/auth/me", headers=_hdr(token)).json()
    user_id = _uuid.UUID(me["id"])

    cls = _make_class(db_session, _uuid.UUID(pid), idx=0)

    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="1")
    a2, f2 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="2")
    a3, f3 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="3")

    # Commit each annotation in its own transaction so the database
    # stamps a distinct ``updated_at`` per row. Without this, all three
    # rows would share one transaction timestamp and the endpoint's
    # ORDER BY updated_at DESC LIMIT 1 would be non-deterministic.
    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, user_id)
    db_session.commit()
    _make_bbox(db_session, _uuid.UUID(tid), f2.id, cls.id, user_id)
    db_session.commit()
    _make_bbox(db_session, _uuid.UUID(tid), f3.id, cls.id, user_id)
    db_session.commit()

    r = client.get(f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["last_asset_id"] == str(a3.id)
    assert body["last_frame_id"] == str(f3.id)
    assert body["annotated_assets"] == 3
    assert body["total_assets"] == 3
    assert body["last_activity_at"] is not None


def test_resume_isolates_users(db_session) -> None:
    """User B's annotations do not leak into User A's resume."""
    client = _client(db_session)
    token_a = _register_and_login(client, "a@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token_a)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token_a),
    ).json()["id"]

    # After the first user exists the API requires an admin token to register
    # new accounts.  User A is the workspace bootstrap admin.
    client.post(
        "/auth/register",
        json={"email": "b@x.com", "password": "hunter22"},
        headers=_hdr(token_a),
    )
    token_b = client.post(
        "/auth/login", json={"email": "b@x.com", "password": "hunter22"}
    ).json()["access_token"]

    me_a = client.get("/auth/me", headers=_hdr(token_a)).json()
    me_b = client.get("/auth/me", headers=_hdr(token_b)).json()
    uid_a = _uuid.UUID(me_a["id"])
    uid_b = _uuid.UUID(me_b["id"])

    # Add User B as a project member directly via DB (no dedicated POST endpoint)
    db_session.add(
        ProjectMember(
            project_id=_uuid.UUID(pid),
            user_id=uid_b,
            role="member",
            added_by=uid_a,
        )
    )
    db_session.flush()

    cls = _make_class(db_session, _uuid.UUID(pid), idx=0)
    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="A")
    a2, f2 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="B")

    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, uid_a)
    _make_bbox(db_session, _uuid.UUID(tid), f2.id, cls.id, uid_b)
    db_session.commit()

    body_a = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token_a)
    ).json()
    body_b = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token_b)
    ).json()

    assert body_a["last_asset_id"] == str(a1.id)
    assert body_a["annotated_assets"] == 1
    assert body_b["last_asset_id"] == str(a2.id)
    assert body_b["annotated_assets"] == 1


def test_resume_ignores_null_frame_id(db_session) -> None:
    """Tag-kind annotations (frame_id=NULL) must not become the resume target."""
    client = _client(db_session)
    token = _register_and_login(client, "nullframe@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    me = client.get("/auth/me", headers=_hdr(token)).json()
    uid = _uuid.UUID(me["id"])

    cls = _make_class(db_session, _uuid.UUID(pid), idx=0)
    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid), idx_suffix="1")

    db_session.add(
        Annotation(
            id=_uuid.uuid4(),
            task_id=_uuid.UUID(tid),
            frame_id=None,
            class_id=cls.id,
            kind=AnnotationKind.tag,
            geometry={"label": "scene"},
            created_by=uid,
        )
    )
    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, uid)
    db_session.commit()

    body = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token)
    ).json()
    assert body["last_asset_id"] == str(a1.id)
    assert body["last_frame_id"] == str(f1.id)
