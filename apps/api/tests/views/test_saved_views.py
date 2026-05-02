"""Tests for the saved-views API (Plan-13 Phase 7 Task 8).

Covers:
  * Round-trip: POST then GET returns the row.
  * shared=true is visible to other project members.
  * PATCH owner-only (non-owner non-admin gets 403).
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Project, ProjectMember, Task, TaskKind


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def world(db_session) -> dict[str, Any]:
    owner = User(
        email=f"sv-owner-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    member = User(
        email=f"sv-mem-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    outsider = User(
        email=f"sv-out-{uuid.uuid4()}@x.com",
        password_hash="x",
        role=UserRole.member,
    )
    db_session.add_all([owner, member, outsider])
    db_session.flush()

    project = Project(name=f"SV-P-{uuid.uuid4()}", owner_id=owner.id)
    db_session.add(project)
    db_session.flush()
    db_session.add_all(
        [
            ProjectMember(project_id=project.id, user_id=owner.id, role="owner"),
            ProjectMember(project_id=project.id, user_id=member.id, role="member"),
        ]
    )
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db_session.add(task)
    db_session.flush()
    return {
        "owner": owner,
        "member": member,
        "outsider": outsider,
        "project": project,
        "task": task,
    }


def test_create_then_list_round_trip(db_session, world) -> None:
    client = _client(db_session)
    task = world["task"]
    member = world["member"]

    r = client.post(
        f"/tasks/{task.id}/views",
        json={"name": "My filter", "query": {"class_id": "abc"}, "shared": False},
        headers=_hdr(member),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "My filter"
    assert body["owner"] == str(member.id)
    assert body["shared"] is False
    assert body["query"] == {"class_id": "abc"}

    r2 = client.get(
        f"/tasks/{task.id}/views", headers=_hdr(member)
    )
    assert r2.status_code == 200, r2.text
    items = r2.json()
    assert any(v["id"] == body["id"] for v in items)


def test_shared_view_visible_to_other_member(db_session, world) -> None:
    client = _client(db_session)
    task = world["task"]
    owner = world["owner"]
    member = world["member"]

    # owner creates a shared view.
    created = client.post(
        f"/tasks/{task.id}/views",
        json={"name": "shared-by-owner", "query": {}, "shared": True},
        headers=_hdr(owner),
    ).json()

    # member sees it.
    items = client.get(
        f"/tasks/{task.id}/views", headers=_hdr(member)
    ).json()
    assert any(v["id"] == created["id"] and v["shared"] is True for v in items)

    # owner also creates a private view (shared=false). member must NOT see it.
    private = client.post(
        f"/tasks/{task.id}/views",
        json={"name": "private", "query": {}, "shared": False},
        headers=_hdr(owner),
    ).json()
    items_after = client.get(
        f"/tasks/{task.id}/views", headers=_hdr(member)
    ).json()
    assert all(v["id"] != private["id"] for v in items_after)


def test_patch_owner_only(db_session, world) -> None:
    client = _client(db_session)
    task = world["task"]
    owner = world["owner"]
    member = world["member"]

    created = client.post(
        f"/tasks/{task.id}/views",
        json={"name": "mine", "query": {}, "shared": True},
        headers=_hdr(member),
    ).json()

    # Non-owner non-admin (the project owner is admin/owner here, so use a
    # second member to be the "outsider" within the project). We use the
    # workspace outsider with a project membership added as plain "member"
    # to assert that membership alone does not grant edit rights.
    outsider = world["outsider"]
    db_session.add(
        ProjectMember(
            project_id=world["project"].id,
            user_id=outsider.id,
            role="member",
        )
    )
    db_session.flush()

    r = client.patch(
        f"/views/{created['id']}",
        json={"name": "hijacked"},
        headers=_hdr(outsider),
    )
    assert r.status_code == 403, r.text

    # Owner of the view CAN patch.
    r2 = client.patch(
        f"/views/{created['id']}",
        json={"name": "renamed"},
        headers=_hdr(member),
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["name"] == "renamed"

    # Project owner (an admin/owner role) can also patch even though they
    # do not own the view.
    r3 = client.patch(
        f"/views/{created['id']}",
        json={"shared": False},
        headers=_hdr(owner),
    )
    assert r3.status_code == 200, r3.text
    assert r3.json()["shared"] is False


def test_delete_owner_or_admin(db_session, world) -> None:
    client = _client(db_session)
    task = world["task"]
    member = world["member"]

    created = client.post(
        f"/tasks/{task.id}/views",
        json={"name": "to-delete", "query": {}, "shared": False},
        headers=_hdr(member),
    ).json()

    r = client.delete(
        f"/views/{created['id']}",
        headers=_hdr(member),
    )
    assert r.status_code == 204, r.text

    # Already gone.
    r2 = client.delete(
        f"/views/{created['id']}",
        headers=_hdr(member),
    )
    assert r2.status_code == 404, r2.text
