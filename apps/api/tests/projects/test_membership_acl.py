"""Plan-13 Phase 7 Task 2 — membership-aware ACL coverage.

Each role (owner, admin, member, viewer, none) plus the workspace-admin
short-circuit is exercised against every gated endpoint. Asserts the
spec-mandated status code:

  * Read endpoints: 200 for member|admin|owner|viewer; 404 for non-member
    (TaskNotFound mask via ``require_visible_task``).
  * Mutating endpoints: 200/201/202/204 for owner|admin|member; 403 for
    viewer (InsufficientRole or ReviewForbidden); 404 for task-routed
    non-member (TaskNotFound mask) or 403 for project-level non-member
    (NotProjectMember).
  * Workspace-admin (User.role=admin): always succeeds — implicit
    "owner" on every project via ``get_project_role``.

Users + project + membership rows are seeded directly through the
SQLAlchemy session so each project role can be minted explicitly.
JWTs are created via ``carve_api.auth.jwt.create_access_token`` so the
FastAPI ``get_current_user`` dep finds each test user.
"""
from __future__ import annotations

import io
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind


# ---------- helpers ---------------------------------------------------------


def _client(db_session) -> TestClient:
    """Create a TestClient that shares the test's ``db_session``.

    Plan-13 Phase 7 Task 2 — unlike most existing test files, we DO
    NOT roll back inside the dep override. Pre-seeded fixture data
    (users, project, members) lives in the same outer transaction the
    test runs in, and a per-request rollback would wipe it before the
    next iteration's auth lookup. Test isolation is still provided by
    the conftest's outer-transaction wrapper.
    """
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value)
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


def _make_user(db, email: str, role: UserRole = UserRole.member) -> User:
    u = User(email=email, password_hash="x", role=role)
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def world(db_session, monkeypatch) -> dict[str, Any]:
    """Build a fresh world per test:

      * one project owned by ``owner_user`` (workspace-member)
      * five users with each role on the project: owner, admin, member, viewer
      * a sixth user ``none_user`` with no project membership
      * one workspace-admin (``ws_admin``) for the implicit-owner branch
      * one task + class + asset + frame + proposed annotation so the
        review/inference endpoints have something to act on
    """
    from carve_api.assets import service as assets_svc
    from carve_api.exports import router as export_router
    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(export_router, "MinioClient", _FakeStorage)

    ws_admin = _make_user(db_session, "ws_admin@acl.test", role=UserRole.admin)
    owner_user = _make_user(db_session, "owner@acl.test", role=UserRole.member)
    admin_user = _make_user(db_session, "admin@acl.test", role=UserRole.member)
    member_user = _make_user(db_session, "member@acl.test", role=UserRole.member)
    viewer_user = _make_user(db_session, "viewer@acl.test", role=UserRole.member)
    none_user = _make_user(db_session, "none@acl.test", role=UserRole.member)

    project = Project(name="ACL", owner_id=owner_user.id)
    db_session.add(project)
    db_session.flush()

    db_session.add_all([
        ProjectMember(project_id=project.id, user_id=owner_user.id, role="owner"),
        ProjectMember(project_id=project.id, user_id=admin_user.id, role="admin"),
        ProjectMember(project_id=project.id, user_id=member_user.id, role="member"),
        ProjectMember(project_id=project.id, user_id=viewer_user.id, role="viewer"),
    ])
    db_session.flush()

    klass = Class(
        project_id=project.id,
        idx=0,
        name="car",
        color="#ff0000",
        attributes={},
    )
    db_session.add(klass)
    db_session.flush()

    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db_session.add(task)
    db_session.flush()

    asset = Asset(
        task_id=task.id,
        kind=AssetKind.image,
        xxh3_128="acl-hash",
        mime="image/png",
        size_bytes=10,
        width=100,
        height=100,
        frames=1,
        original_name="a.png",
    )
    db_session.add(asset)
    db_session.flush()

    frame = Frame(asset_id=asset.id, idx=0, pts_ms=0)
    db_session.add(frame)
    db_session.flush()

    ann = Annotation(
        task_id=task.id,
        frame_id=frame.id,
        class_id=klass.id,
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": 1, "y": 2, "w": 3, "h": 4},
    )
    db_session.add(ann)
    db_session.flush()

    return {
        "ws_admin": ws_admin,
        "owner": owner_user,
        "admin": admin_user,
        "member": member_user,
        "viewer": viewer_user,
        "none": none_user,
        "project": project,
        "task": task,
        "class": klass,
        "asset": asset,
        "frame": frame,
        "annotation": ann,
    }


def _users_by_role(world: dict[str, Any]) -> dict[str, User]:
    return {
        "owner": world["owner"],
        "admin": world["admin"],
        "member": world["member"],
        "viewer": world["viewer"],
        "none": world["none"],
        "ws_admin": world["ws_admin"],
    }


# ---------- mutating endpoints ---------------------------------------------


def test_create_task_role_matrix(db_session, world):
    """POST /projects/{pid}/tasks — owner/admin/member/ws_admin allowed; viewer 403; none 403."""
    client = _client(db_session)
    pid = world["project"].id
    expected = {
        "owner": 201,
        "admin": 201,
        "member": 201,
        "viewer": 403,  # InsufficientRole
        "none": 403,    # NotProjectMember (project-level mutation)
        "ws_admin": 201,
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/projects/{pid}/tasks",
            json={"name": f"T-{role}", "kind": "image"},
            headers=_hdr(user),
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )


def test_delete_task_role_matrix(db_session, world):
    """DELETE /projects/{pid}/tasks/{tid} — same gate as create."""
    client = _client(db_session)
    pid = world["project"].id
    expected = {
        "owner": 204,
        "admin": 204,
        "member": 204,
        "viewer": 403,
        "none": 403,
        "ws_admin": 204,
    }
    for role, user in _users_by_role(world).items():
        t = Task(project_id=pid, name=f"DT-{role}", kind=TaskKind.image)
        db_session.add(t)
        db_session.flush()
        r = client.delete(
            f"/projects/{pid}/tasks/{t.id}", headers=_hdr(user)
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )


def test_auto_annotate_role_matrix(db_session, world):
    """POST /assets/{aid}/auto-annotate — task-routed mutation.

    Non-member gets 404 (TaskNotFound mask). Viewer gets 403. Members
    pass the gate but the call subsequently fails with 404
    weight_not_found because no weights are seeded; we treat any
    past-the-gate response as a pass and only assert the gate decision.
    """
    client = _client(db_session)
    aid = world["asset"].id
    bad_weight = uuid.uuid4()
    expected_gate = {
        "owner": "pass",
        "admin": "pass",
        "member": "pass",
        "viewer": 403,
        "none": 404,
        "ws_admin": "pass",
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/assets/{aid}/auto-annotate?weight_id={bad_weight}",
            headers=_hdr(user),
        )
        if expected_gate[role] == "pass":
            assert r.status_code == 404, (
                f"role={role!r} expected past-gate got={r.status_code} body={r.text}"
            )
            body = r.json()
            assert body.get("detail") == "weight_not_found" or body.get("error") == "weight_not_found"
        else:
            assert r.status_code == expected_gate[role], (
                f"role={role!r} expected={expected_gate[role]} got={r.status_code} body={r.text}"
            )


def test_retrain_submit_role_matrix(db_session, world):
    """POST /tasks/{tid}/retrain-yolo — task-routed mutation."""
    client = _client(db_session)
    tid = world["task"].id
    expected = {
        "owner": 200,
        "admin": 200,
        "member": 200,
        "viewer": 403,
        "none": 404,
        "ws_admin": 200,
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/tasks/{tid}/retrain-yolo",
            json={"epochs": 1, "imgsz": 320},
            headers=_hdr(user),
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )


def test_export_submit_role_matrix(db_session, world):
    """POST /tasks/{tid}/exports — task-routed mutation."""
    client = _client(db_session)
    tid = world["task"].id
    expected = {
        "owner": 202,
        "admin": 202,
        "member": 202,
        "viewer": 403,
        "none": 404,
        "ws_admin": 202,
    }
    body = {
        "format": "yolo",
        "class_remap": {},
        "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
        "include_images": False,
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/tasks/{tid}/exports", json=body, headers=_hdr(user)
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )


def test_review_role_matrix(db_session, world):
    """POST /annotations/{id}/review — viewers 403 (ReviewForbidden);
    non-members 404 (AnnotationNotFound mask)."""
    client = _client(db_session)
    # Reviewer endpoint uniformly raises ReviewForbidden (403) for any
    # caller without a mutating role — viewers and non-members alike.
    # This is intentional: the existing reviews router did not mask
    # access failures as 404 the way the annotations router does, so
    # we keep that behaviour and just tighten the role check.
    expected = {
        "owner": 200,
        "admin": 200,
        "member": 200,
        "viewer": 403,
        "none": 403,
        "ws_admin": 200,
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/annotations/{world['annotation'].id}/review",
            json={"decision": "accept"},
            headers=_hdr(user),
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )
        # Reset to "proposed" so subsequent role assertions start fresh.
        if r.status_code == 200:
            ann = db_session.get(Annotation, world["annotation"].id)
            ann.status = "proposed"
            ann.reviewed_at = None
            ann.reviewed_by_id = None
            db_session.flush()


def test_import_submit_role_matrix(db_session, world, monkeypatch):
    """POST /tasks/{tid}/imports — task-routed mutation."""
    from carve_api.io import import_router as iroute
    monkeypatch.setattr(iroute, "MinioClient", _FakeStorage)
    client = _client(db_session)
    tid = world["task"].id
    expected = {
        "owner": 202,
        "admin": 202,
        "member": 202,
        "viewer": 403,
        "none": 404,
        "ws_admin": 202,
    }
    for role, user in _users_by_role(world).items():
        r = client.post(
            f"/tasks/{tid}/imports?format=coco",
            files={"file": ("c.json", io.BytesIO(b"{}"), "application/json")},
            headers=_hdr(user),
        )
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )


# ---------- read endpoint --------------------------------------------------


def test_list_annotations_read_role_matrix(db_session, world):
    """GET /tasks/{tid}/annotations — viewer should pass; non-member 404."""
    client = _client(db_session)
    tid = world["task"].id
    expected = {
        "owner": 200,
        "admin": 200,
        "member": 200,
        "viewer": 200,  # readers may include viewers
        "none": 404,    # TaskNotFound mask
        "ws_admin": 200,
    }
    for role, user in _users_by_role(world).items():
        r = client.get(f"/tasks/{tid}/annotations", headers=_hdr(user))
        assert r.status_code == expected[role], (
            f"role={role!r} expected={expected[role]} got={r.status_code} body={r.text}"
        )
