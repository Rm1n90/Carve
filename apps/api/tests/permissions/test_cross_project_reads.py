"""IDOR coverage — project-scoped READS must prove membership.

Mutating routes have enforced ``require_project_role`` since Plan-13
Phase 7 Task 2, but several read routes resolved the project through
``ProjectService.get``, which deliberately ignores its ``actor``
argument. Any authenticated user who guessed a project id could read
that project's detail, task list, class list, analytics rollup and
weight inventory.

Task-scoped data (assets, annotations) was never exposed — those go
through ``require_visible_task``, which does check membership and masks
failures as 404. These tests pin the metadata routes that did not.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Class, Project, ProjectMember, Task, TaskKind
from carve_api.weights.models import Weight, WeightTaskKind


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    return {
        "Authorization": (
            f"Bearer {create_access_token(subject=str(user.id), role=user.role.value)}"
        )
    }


def _user(db_session, label: str, role: UserRole) -> User:
    u = User(
        email=f"{label}-{uuid.uuid4().hex[:8]}@idor.test",
        password_hash=hash_password("x" * 12),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


@pytest.fixture()
def world(db_session) -> dict:
    """Two projects. ``outsider`` is a member of ``mine`` only, so every
    request below aims at ``theirs`` — a project they have no row for."""
    admin = _user(db_session, "admin", UserRole.admin)
    outsider = _user(db_session, "outsider", UserRole.member)

    mine = Project(name="Mine", owner_id=admin.id)
    theirs = Project(name="Theirs", owner_id=admin.id)
    db_session.add_all([mine, theirs])
    db_session.flush()
    db_session.add(
        ProjectMember(project_id=mine.id, user_id=outsider.id, role="member")
    )
    task = Task(project_id=theirs.id, name="T", kind=TaskKind.image)
    db_session.add(task)
    db_session.add(
        Class(
            project_id=theirs.id, idx=0, name="secret-class",
            color="#ff0000", attributes={},
        )
    )
    db_session.add(
        Weight(
            project_id=theirs.id,
            name="their-detector",
            task_kind=WeightTaskKind.detect,
            minio_key="weights/secret/abc.pt",
            size_bytes=1,
            class_names=["proprietary-label"],
        )
    )
    db_session.flush()
    return {
        "admin": admin, "outsider": outsider,
        "mine": mine, "theirs": theirs, "task": task,
    }


def test_non_member_cannot_read_foreign_project_metadata(db_session, world):
    """Detail, tasks, classes, analytics and weights of a project the
    caller has no membership row for."""
    client = _client(db_session)
    tid, pid = world["task"].id, world["theirs"].id
    hdr = _hdr(world["outsider"])
    for url in (
        f"/projects/{pid}",
        f"/projects/{pid}/tasks",
        f"/projects/{pid}/classes",
        f"/projects/{pid}/stats",
        f"/projects/{pid}/stats/reviewer-quality",
        f"/projects/{pid}/stats/retrain-history",
        f"/projects/{pid}/weights",
        f"/projects/{pid}/tasks/{tid}/classes",
        f"/projects/{pid}/tasks/{tid}/completion-status",
    ):
        r = client.get(url, headers=hdr)
        assert r.status_code in (403, 404), f"{url} leaked: {r.status_code} {r.text}"


def test_member_can_still_read_their_own_project(db_session, world):
    """The gate must not break the project the member was invited to."""
    client = _client(db_session)
    hdr = _hdr(world["outsider"])
    pid = world["mine"].id
    for url in (
        f"/projects/{pid}",
        f"/projects/{pid}/tasks",
        f"/projects/{pid}/classes",
        f"/projects/{pid}/stats",
    ):
        assert client.get(url, headers=hdr).status_code == 200, url


def test_admin_still_reads_every_project(db_session, world):
    client = _client(db_session)
    hdr = _hdr(world["admin"])
    pid = world["theirs"].id
    for url in (f"/projects/{pid}", f"/projects/{pid}/tasks", f"/projects/{pid}/stats"):
        assert client.get(url, headers=hdr).status_code == 200, url


def test_workspace_weight_listing_is_scoped_to_member_projects(db_session, world):
    """``GET /weights`` returned every weight in the workspace to any
    authenticated user, exposing the whole model inventory."""
    client = _client(db_session)
    rows = client.get("/weights", headers=_hdr(world["outsider"])).json()
    names = {w["name"] for w in rows}
    assert "their-detector" not in names, f"leaked foreign weight: {names}"

    admin_rows = client.get("/weights", headers=_hdr(world["admin"])).json()
    assert "their-detector" in {w["name"] for w in admin_rows}


def test_weight_artifact_fields_are_redacted_for_non_admins(db_session, world):
    """A member may need to pick a weight by name on a granted task, but
    the storage key and retrain metadata are workspace IP."""
    client = _client(db_session)
    w = Weight(
        project_id=world["mine"].id,
        name="visible-to-member",
        task_kind=WeightTaskKind.detect,
        minio_key="weights/secret/xyz.pt",
        size_bytes=1,
        class_names=["a"],
    )
    db_session.add(w)
    db_session.flush()

    rows = client.get(
        f"/projects/{world['mine'].id}/weights", headers=_hdr(world["outsider"])
    ).json()
    row = next(r for r in rows if r["name"] == "visible-to-member")
    assert row["minio_key"] == ""
    assert row["metadata"] is None

    admin_rows = client.get(
        f"/projects/{world['mine'].id}/weights", headers=_hdr(world["admin"])
    ).json()
    admin_row = next(r for r in admin_rows if r["name"] == "visible-to-member")
    assert admin_row["minio_key"] == "weights/secret/xyz.pt"


def test_task_scoped_data_was_already_safe(db_session, world):
    """Regression guard: assets/annotations of a foreign task must stay
    masked as 404 (never 403, which would confirm the task exists)."""
    client = _client(db_session)
    tid = world["task"].id
    hdr = _hdr(world["outsider"])
    for url in (f"/tasks/{tid}/assets", f"/tasks/{tid}/annotations"):
        assert client.get(url, headers=hdr).status_code == 404, url
