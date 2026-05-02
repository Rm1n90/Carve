"""Plan-13 Phase 7 Task 4 -- per-project invitation flow.

Covers the spec checklist:
  1. Create invite, assert token returned once and token_hash present in DB.
  2. Accept with token: existing user -> joined as member.
  3. Accept with token: new email + password -> user created + JWT issued + joined.
  4. Expired token: 410.
  5. Already-accepted token: 409.
  6. Email already a member: 409 on POST.
  7. Last-owner demote: 422.
  8. Last-owner remove: 422.
  9. Audit events fire for create + accept + role-change + remove.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from carve_api.audit.actions import (
    PROJECT_MEMBER_ADDED,
    PROJECT_MEMBER_REMOVED,
    PROJECT_MEMBER_ROLE_CHANGED,
)
from carve_api.audit.models import AuditEvent
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.deps import get_db
from carve_api.invites.models import ProjectInvite
from carve_api.invites.service import hash_token
from carve_api.main import create_app
from carve_api.projects.models import Project, ProjectMember


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value)
    return {"Authorization": f"Bearer {token}"}


def _make_user(
    db, email: str, *, role: UserRole = UserRole.member, password: str | None = None
) -> User:
    pw = hash_password(password) if password else "x"
    u = User(email=email, password_hash=pw, role=role)
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def world(db_session) -> dict[str, Any]:
    """One project, one owner, one admin, one outsider."""
    owner = _make_user(db_session, "inv_owner@x.com", role=UserRole.member)
    admin = _make_user(db_session, "inv_admin@x.com", role=UserRole.member)
    member = _make_user(
        db_session,
        "inv_existing@x.com",
        role=UserRole.member,
        password="hunter22long",
    )
    project = Project(name="Inv-P", owner_id=owner.id)
    db_session.add(project)
    db_session.flush()
    db_session.add_all(
        [
            ProjectMember(project_id=project.id, user_id=owner.id, role="owner"),
            ProjectMember(project_id=project.id, user_id=admin.id, role="admin"),
        ]
    )
    db_session.flush()
    return {
        "owner": owner,
        "admin": admin,
        "existing_user": member,
        "project": project,
    }


def test_create_invite_returns_token_once_and_hashes_in_db(
    db_session, world
) -> None:
    client = _client(db_session)
    project = world["project"]

    r = client.post(
        f"/projects/{project.id}/invites",
        json={"email": "newperson@x.com", "role": "member"},
        headers=_hdr(world["owner"]),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "newperson@x.com"
    assert body["role"] == "member"
    raw_token = body["token"]
    assert raw_token and len(raw_token) >= 30

    invite = (
        db_session.query(ProjectInvite)
        .filter(ProjectInvite.id == uuid.UUID(body["id"]))
        .one()
    )
    expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    assert invite.token_hash == expected_hash
    assert invite.token_hash == hash_token(raw_token)
    assert invite.accepted_at is None


def test_accept_existing_user_joins_project(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]
    existing = world["existing_user"]

    raw = client.post(
        f"/projects/{project.id}/invites",
        json={"email": existing.email, "role": "member"},
        headers=_hdr(world["owner"]),
    ).json()["token"]

    r = client.post(
        "/invites/accept",
        json={"token": raw},
        headers=_hdr(existing),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project_id"] == str(project.id)
    assert body["role"] == "member"
    assert body["jwt"] is None

    db_session.expire_all()
    pm = (
        db_session.query(ProjectMember)
        .filter(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == existing.id,
        )
        .one()
    )
    assert pm.role == "member"


def test_accept_new_user_registers_and_joins(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]

    raw = client.post(
        f"/projects/{project.id}/invites",
        json={"email": "fresh@x.com", "role": "viewer"},
        headers=_hdr(world["owner"]),
    ).json()["token"]

    r = client.post(
        "/invites/accept",
        json={"token": raw, "password": "hunter22long"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["jwt"] is not None
    assert body["refresh_token"] is not None
    new_user_id = uuid.UUID(body["user"]["id"])

    db_session.expire_all()
    user = db_session.get(User, new_user_id)
    assert user is not None
    assert user.email == "fresh@x.com"

    pm = (
        db_session.query(ProjectMember)
        .filter(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == new_user_id,
        )
        .one()
    )
    assert pm.role == "viewer"


def test_accept_expired_token_returns_410(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]

    raw_token = "synthetic-but-unique-token-for-expiry-test-xyz"
    invite = ProjectInvite(
        project_id=project.id,
        email="someone@x.com",
        role="member",
        token_hash=hash_token(raw_token),
        invited_by=world["owner"].id,
        expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    db_session.add(invite)
    db_session.flush()

    r = client.post(
        "/invites/accept",
        json={"token": raw_token, "password": "hunter22long"},
    )
    assert r.status_code == 410, r.text


def test_accept_already_accepted_token_returns_409(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]

    raw = client.post(
        f"/projects/{project.id}/invites",
        json={"email": "someone-else@x.com", "role": "member"},
        headers=_hdr(world["owner"]),
    ).json()["token"]

    r1 = client.post(
        "/invites/accept",
        json={"token": raw, "password": "hunter22long"},
    )
    assert r1.status_code == 200, r1.text

    r2 = client.post(
        "/invites/accept",
        json={"token": raw, "password": "hunter22long"},
    )
    assert r2.status_code == 409, r2.text


def test_create_invite_for_existing_member_returns_409(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]

    r = client.post(
        f"/projects/{project.id}/invites",
        json={"email": world["admin"].email, "role": "member"},
        headers=_hdr(world["owner"]),
    )
    assert r.status_code == 409, r.text


def test_demote_last_owner_returns_422(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]
    owner = world["owner"]

    r = client.post(
        f"/projects/{project.id}/members/{owner.id}/role",
        json={"role": "admin"},
        headers=_hdr(owner),
    )
    assert r.status_code == 422, r.text
    body = r.json()
    assert body.get("error") == "last_owner"


def test_remove_last_owner_returns_422(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]
    owner = world["owner"]

    r = client.delete(
        f"/projects/{project.id}/members/{owner.id}",
        headers=_hdr(owner),
    )
    assert r.status_code == 422, r.text
    assert r.json().get("error") == "last_owner"


def test_audit_events_fire_for_invite_lifecycle(db_session, world) -> None:
    client = _client(db_session)
    project = world["project"]
    owner = world["owner"]
    admin = world["admin"]
    existing = world["existing_user"]

    raw = client.post(
        f"/projects/{project.id}/invites",
        json={"email": existing.email, "role": "member"},
        headers=_hdr(owner),
    ).json()["token"]

    r = client.post(
        "/invites/accept",
        json={"token": raw},
        headers=_hdr(existing),
    )
    assert r.status_code == 200, r.text

    r = client.post(
        f"/projects/{project.id}/members/{existing.id}/role",
        json={"role": "admin"},
        headers=_hdr(owner),
    )
    assert r.status_code == 200, r.text

    r = client.delete(
        f"/projects/{project.id}/members/{admin.id}",
        headers=_hdr(owner),
    )
    assert r.status_code == 204, r.text

    db_session.expire_all()
    actions = {
        ev.action
        for ev in db_session.query(AuditEvent)
        .filter(AuditEvent.project_id == project.id)
        .all()
    }
    assert "project_invite.created" in actions
    assert PROJECT_MEMBER_ADDED in actions
    assert PROJECT_MEMBER_ROLE_CHANGED in actions
    assert PROJECT_MEMBER_REMOVED in actions
