"""Outsourcing hardening — workspace-role capability gates.

Covers ``carve_api.permissions``: non-admins can annotate and save but
cannot export, upload, import, duplicate/copy, or touch GPU/model
features — unless a workspace admin has granted the *specific* task via
``tasks.gpu_access_for_members``.

The fixtures mirror ``tests/projects/test_membership_acl.py``: the
project member here holds a full mutating project role, so every refusal
below is attributable to the workspace-role gate and not to project ACL.
"""
from __future__ import annotations

import io
import uuid

import pytest
from fastapi.testclient import TestClient

from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind

# ---------- helpers ---------------------------------------------------------


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

    def presigned_get(self, *a, **k):
        return "http://example.invalid/blob"


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value)
    return {"Authorization": f"Bearer {token}"}


def _make_user(db_session, email: str, role: UserRole) -> User:
    u = User(email=email, password_hash=hash_password("x" * 12), role=role)
    db_session.add(u)
    db_session.flush()
    return u


@pytest.fixture()
def world(db_session, monkeypatch) -> dict:
    """One project, one task, a workspace admin and a workspace member.

    The member is given the ``member`` *project* role so they pass every
    pre-existing project ACL check — anything they are refused below is
    the new workspace-role gate talking.
    """
    from carve_api.assets import service as assets_svc
    from carve_api.exports import router as export_router

    monkeypatch.setattr(assets_svc, "MinioClient", _FakeStorage)
    monkeypatch.setattr(export_router, "MinioClient", _FakeStorage)

    suffix = uuid.uuid4().hex[:8]
    admin = _make_user(db_session, f"admin-{suffix}@perm.test", UserRole.admin)
    member = _make_user(db_session, f"member-{suffix}@perm.test", UserRole.member)

    project = Project(name="Outsourced", owner_id=admin.id)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        ProjectMember(project_id=project.id, user_id=member.id, role="member")
    )
    db_session.add(
        Class(project_id=project.id, idx=0, name="car", color="#ff0000", attributes={})
    )
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db_session.add(task)
    db_session.flush()
    return {
        "admin": admin,
        "member": member,
        "project": project,
        "task": task,
    }


def _grant_gpu(db_session, task: Task) -> None:
    task.gpu_access_for_members = True
    db_session.flush()


# ---------- data movement: export / upload / import / duplicate / copy ------


def test_export_is_admin_only(db_session, world):
    client = _client(db_session)
    body = {
        "format": "yolo",
        "class_remap": {},
        "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
        "include_images": False,
    }
    url = f"/tasks/{world['task'].id}/exports"

    r = client.post(url, json=body, headers=_hdr(world["member"]))
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"

    assert client.post(url, json=body, headers=_hdr(world["admin"])).status_code == 202


def test_export_progress_and_kinds_are_admin_only(db_session, world):
    """The whole exports router is gated, not just the enqueue route —
    otherwise a member could poll a job an admin started and read its
    download URL."""
    client = _client(db_session)
    tid = world["task"].id
    for url in (
        f"/tasks/{tid}/annotation-kinds",
        f"/tasks/{tid}/exports/{uuid.uuid4()}",
    ):
        r = client.get(url, headers=_hdr(world["member"]))
        assert r.status_code == 403, url
        assert r.json()["error"] == "data_movement_forbidden"


def test_asset_upload_is_admin_only(db_session, world):
    client = _client(db_session)
    url = f"/tasks/{world['task'].id}/assets"
    files = {"file": ("a.png", b"\x89PNG\r\n\x1a\n", "image/png")}

    r = client.post(url, files=files, headers=_hdr(world["member"]))
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"


def test_archive_upload_is_admin_only(db_session, world):
    client = _client(db_session)
    url = f"/tasks/{world['task'].id}/assets:zip"
    files = {"file": ("a.zip", b"PK\x05\x06" + b"\x00" * 18, "application/zip")}

    r = client.post(url, files=files, headers=_hdr(world["member"]))
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"


def test_annotation_import_is_admin_only(db_session, world):
    client = _client(db_session)
    url = f"/tasks/{world['task'].id}/imports"
    files = {"files": ("labels.zip", b"PK\x05\x06" + b"\x00" * 18, "application/zip")}

    r = client.post(
        url + "?format=yolo", files=files, headers=_hdr(world["member"])
    )
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"


def test_task_duplicate_is_admin_only(db_session, world):
    client = _client(db_session)
    url = f"/projects/{world['project'].id}/tasks/{world['task'].id}/duplicate"

    r = client.post(url, headers=_hdr(world["member"]))
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"

    assert client.post(url, headers=_hdr(world["admin"])).status_code == 201


def test_class_import_is_admin_only(db_session, world):
    client = _client(db_session)
    other = Project(name="Source", owner_id=world["admin"].id)
    db_session.add(other)
    db_session.flush()

    r = client.post(
        f"/projects/{world['project'].id}/classes/import",
        json={"source_project_id": str(other.id)},
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"


def test_workspace_weight_upload_is_admin_only(db_session, world):
    """Regression: this route previously had no role check at all, so any
    authenticated user could push a .pt into the workspace."""
    client = _client(db_session)
    r = client.post(
        "/weights",
        data={"name": "w", "task_kind": "detect"},
        files={"file": ("w.pt", b"not-a-real-weight", "application/octet-stream")},
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "data_movement_forbidden"


# ---------- GPU / model features -------------------------------------------


def test_gpu_routes_refused_without_grant(db_session, world):
    """My Model, Auto-Annotate, Smart Find and interactive SAM all refuse
    a workspace member while the task carries no AI grant."""
    client = _client(db_session)
    tid = world["task"].id
    hdr = _hdr(world["member"])

    refusals = [
        client.post(f"/tasks/{tid}/auto-annotate?weight_id={uuid.uuid4()}", headers=hdr),
        client.post(
            f"/tasks/{tid}/yoloe/batch",
            json={"mode": "prompt_free", "params": {}},
            headers=hdr,
        ),
        client.post(
            f"/tasks/{tid}/sam/auto-text-batch",
            json={"class_ids": [str(uuid.uuid4())]},
            headers=hdr,
        ),
    ]
    for r in refusals:
        assert r.status_code == 403, r.text
        assert r.json()["error"] == "gpu_forbidden", r.text


def test_gpu_grant_reopens_the_task_for_members(db_session, world):
    """The per-task grant is the escape hatch: with it set, the member
    gets past the GPU gate (and then fails on the missing weight, which
    is a past-the-gate outcome)."""
    client = _client(db_session)
    tid = world["task"].id
    hdr = _hdr(world["member"])
    url = f"/tasks/{tid}/auto-annotate?weight_id={uuid.uuid4()}"

    assert client.post(url, headers=hdr).status_code == 403

    _grant_gpu(db_session, world["task"])

    r = client.post(url, headers=hdr)
    assert r.status_code != 403, r.text
    assert "gpu_forbidden" not in r.text


def test_gpu_grant_is_scoped_to_one_task(db_session, world):
    """Granting task A must not unlock task B in the same project."""
    client = _client(db_session)
    other = Task(project_id=world["project"].id, name="T2", kind=TaskKind.image)
    db_session.add(other)
    db_session.flush()
    _grant_gpu(db_session, world["task"])

    hdr = _hdr(world["member"])
    r = client.post(
        f"/tasks/{other.id}/auto-annotate?weight_id={uuid.uuid4()}", headers=hdr
    )
    assert r.status_code == 403
    assert r.json()["error"] == "gpu_forbidden"


def test_non_member_still_gets_404_not_403(db_session, world):
    """The GPU check must run *after* visibility so it never reveals that
    a project the caller cannot see exists."""
    client = _client(db_session)
    outsider = _make_user(
        db_session, f"outsider-{uuid.uuid4().hex[:8]}@perm.test", UserRole.member
    )
    r = client.post(
        f"/tasks/{world['task'].id}/auto-annotate?weight_id={uuid.uuid4()}",
        headers=_hdr(outsider),
    )
    assert r.status_code == 404


def test_workspace_wide_gpu_controls_ignore_the_task_grant(db_session, world):
    """Device preference and the active SAM variant are shared by every
    user, so the per-task grant must not unlock them."""
    client = _client(db_session)
    _grant_gpu(db_session, world["task"])
    hdr = _hdr(world["member"])

    r = client.post(
        "/devices/preference", json={"kind": "sam", "device": "cpu"}, headers=hdr
    )
    assert r.status_code == 403
    assert r.json()["error"] == "gpu_forbidden"

    r = client.post("/models/sam-active", json={"variant": "sam3"}, headers=hdr)
    assert r.status_code == 403
    assert r.json()["error"] == "gpu_forbidden"


# ---------- the grant itself is admin-only ---------------------------------


def test_only_admin_can_flip_the_grant(db_session, world):
    client = _client(db_session)
    url = f"/projects/{world['project'].id}/tasks/{world['task'].id}"

    r = client.patch(
        url, json={"gpu_access_for_members": True}, headers=_hdr(world["member"])
    )
    assert r.status_code == 403
    assert r.json()["error"] == "admin_only"

    r = client.patch(
        url, json={"gpu_access_for_members": True}, headers=_hdr(world["admin"])
    )
    assert r.status_code == 200
    assert r.json()["gpu_access_for_members"] is True


def test_member_cannot_revoke_the_grant_either(db_session, world):
    """Presence-checked, not truthiness-checked — sending ``false`` is
    just as much a privileged write as sending ``true``."""
    client = _client(db_session)
    _grant_gpu(db_session, world["task"])
    r = client.patch(
        f"/projects/{world['project'].id}/tasks/{world['task'].id}",
        json={"gpu_access_for_members": False},
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "admin_only"


def test_member_can_still_rename_a_task(db_session, world):
    """The gate must not spill over onto ordinary annotation workflow."""
    client = _client(db_session)
    r = client.patch(
        f"/projects/{world['project'].id}/tasks/{world['task'].id}",
        json={"name": "renamed"},
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 200
    assert r.json()["name"] == "renamed"


# ---------- annotation workflow must be untouched --------------------------


def test_member_can_still_annotate_and_save(db_session, world):
    """The whole point of the gate is that outsourced annotators keep
    working — listing assets and creating/updating annotations stay open.
    """
    client = _client(db_session)
    tid = world["task"].id
    hdr = _hdr(world["member"])

    assert client.get(f"/tasks/{tid}/assets", headers=hdr).status_code == 200
    assert client.get(f"/tasks/{tid}/assets/count", headers=hdr).status_code == 200
    assert client.get(f"/tasks/{tid}/annotations", headers=hdr).status_code == 200
