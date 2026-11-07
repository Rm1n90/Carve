"""What a superadmin can do beyond the account controls of alembic 0039:
see when people last signed in and the whole activity log with names,
change someone's email, see and revoke anyone's API keys, bring back a
removed account, and back up the database on demand.

Admins get none of these: each is checked to refuse them.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from carve_api.api_keys.service import ApiKeyService
from carve_api.app_settings.models import AppSetting
from carve_api.audit import service as audit_service
from carve_api.audit.models import AuditEvent
from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import Project

PASSWORD = "original-pass"


def _client(db_session) -> TestClient:
    app = create_app()

    def _ov():
        yield db_session

    app.dependency_overrides[get_db] = _ov
    return TestClient(app)


def _mk(db_session, label: str, role: UserRole) -> User:
    u = User(
        email=f"{label}-{uuid.uuid4().hex[:6]}@powers.example.com",
        password_hash=hash_password(PASSWORD),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


def _hdr(u: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(subject=str(u.id), role=u.role.value)}"}


@pytest.fixture()
def world(db_session) -> dict:
    return {
        "sa": _mk(db_session, "super", UserRole.superadmin),
        "admin": _mk(db_session, "admin", UserRole.admin),
        "member": _mk(db_session, "member", UserRole.member),
    }


def test_sign_ins_are_recorded_and_shown_on_the_members_list(db_session, world) -> None:
    c = _client(db_session)
    member = world["member"]
    assert (
        c.post("/auth/login", json={"email": member.email, "password": PASSWORD}).status_code == 200
    )

    rows = {m["id"]: m for m in c.get("/auth/members", headers=_hdr(world["sa"])).json()}
    assert rows[str(member.id)]["last_sign_in_at"] is not None
    assert rows[str(world["admin"].id)]["last_sign_in_at"] is None
    ev = db_session.execute(
        select(AuditEvent).where(
            AuditEvent.action == "user.signed_in", AuditEvent.actor_id == member.id
        )
    ).scalar_one()
    assert ev.metadata_ == {"method": "password"}
    # A wrong password is not a sign-in.
    c.post("/auth/login", json={"email": world["admin"].email, "password": "wrong-pass"})
    rows = {m["id"]: m for m in c.get("/auth/members", headers=_hdr(world["sa"])).json()}
    assert rows[str(world["admin"].id)]["last_sign_in_at"] is None


def test_the_activity_log_names_people_and_projects_and_filters(db_session, world) -> None:
    c = _client(db_session)
    sa, member = world["sa"], world["member"]
    project = Project(name="Shelf audit", owner_id=sa.id)
    db_session.add(project)
    db_session.flush()
    audit_service.record(
        db_session,
        actor_id=sa.id,
        action="task.deleted",
        target_type="task",
        target_id=None,
        project_id=project.id,
        summary="deleted task T",
    )
    audit_service.record(
        db_session,
        actor_id=sa.id,
        action="user.blocked",
        target_type="user",
        target_id=member.id,
        project_id=None,
        summary="blocked member",
    )
    audit_service.record(
        db_session,
        actor_id=member.id,
        action="user.signed_in",
        target_type="user",
        target_id=member.id,
        project_id=None,
        summary="signed in",
    )
    db_session.flush()

    items = c.get("/audit", headers=_hdr(sa)).json()["items"]
    deleted = next(i for i in items if i["action"] == "task.deleted")
    assert deleted["actor_email"] == sa.email and deleted["project_name"] == "Shelf audit"

    # Everything about the member: what they did and what was done to them.
    about = c.get("/audit", params={"person": str(member.id)}, headers=_hdr(sa)).json()["items"]
    assert {i["action"] for i in about} == {"user.blocked", "user.signed_in"}
    family = c.get("/audit", params={"action_prefix": "user."}, headers=_hdr(sa)).json()["items"]
    assert {i["action"] for i in family} == {"user.blocked", "user.signed_in"}
    several = c.get(
        "/audit", params={"action": "task.deleted,user.blocked"}, headers=_hdr(sa)
    ).json()["items"]
    assert {i["action"] for i in several} == {"task.deleted", "user.blocked"}

    assert c.get("/audit", headers=_hdr(world["admin"])).status_code == 403


def test_superadmin_changes_an_email_and_the_person_signs_in_with_it(db_session, world) -> None:
    c = _client(db_session)
    sa, admin, member = world["sa"], world["admin"], world["member"]
    member.sso_subject = "google-sub-1"
    db_session.flush()
    new = f"renamed-{uuid.uuid4().hex[:6]}@powers.example.com"

    assert (
        c.patch(
            f"/auth/members/{member.id}/email", json={"email": new}, headers=_hdr(admin)
        ).status_code
        == 403
    )
    r = c.patch(f"/auth/members/{member.id}/email", json={"email": new}, headers=_hdr(sa))
    assert r.status_code == 200, r.text
    assert r.json()["email"] == new
    db_session.refresh(member)
    assert member.sso_subject is None
    assert c.post("/auth/login", json={"email": new, "password": PASSWORD}).status_code == 200

    # Taken by someone else (in any letter case), or by a removed account.
    r = c.patch(
        f"/auth/members/{member.id}/email", json={"email": admin.email.upper()}, headers=_hdr(sa)
    )
    assert r.status_code == 409 and r.json()["error"] == "email_taken"
    gone = _mk(db_session, "gone", UserRole.member)
    gone.deleted_at = datetime.now(timezone.utc)
    db_session.flush()
    r = c.patch(f"/auth/members/{member.id}/email", json={"email": gone.email}, headers=_hdr(sa))
    assert r.status_code == 409 and r.json()["error"] == "email_belongs_to_removed_member"
    # Admin accounts too, but never your own through this surface.
    assert (
        c.patch(
            f"/auth/members/{admin.id}/email", json={"email": f"a-{new}"}, headers=_hdr(sa)
        ).status_code
        == 200
    )
    assert (
        c.patch(
            f"/auth/members/{sa.id}/email", json={"email": f"s-{new}"}, headers=_hdr(sa)
        ).status_code
        == 400
    )


def test_superadmin_can_make_someone_superadmin(db_session, world) -> None:
    c = _client(db_session)
    r = c.patch(
        f"/auth/members/{world['admin'].id}/role",
        json={"role": "superadmin"},
        headers=_hdr(world["sa"]),
    )
    assert r.status_code == 200 and r.json()["role"] == "superadmin"


def test_a_removed_member_is_listed_and_restored(db_session, world) -> None:
    c = _client(db_session)
    sa, admin, member = world["sa"], world["admin"], world["member"]
    old_token = _hdr(member)
    key = ApiKeyService(db_session).create(user=member, name="laptop")
    assert c.delete(f"/auth/members/{member.id}", headers=_hdr(sa)).status_code == 204

    # A new account cannot take the email: the removed one holds it.
    r = c.post(
        "/auth/members",
        json={"email": member.email, "password": "hunter222", "role": "member"},
        headers=_hdr(sa),
    )
    assert r.status_code == 409 and r.json()["error"] == "email_belongs_to_removed_member"

    removed = c.get("/auth/members/removed", headers=_hdr(sa)).json()
    assert [m["email"] for m in removed] == [member.email]
    assert c.get("/auth/members/removed", headers=_hdr(admin)).status_code == 403
    assert c.post(f"/auth/members/{member.id}/restore", headers=_hdr(admin)).status_code == 403

    r = c.post(f"/auth/members/{member.id}/restore", headers=_hdr(sa))
    assert r.status_code == 200 and r.json()["role"] == "member"
    assert c.get("/auth/members/removed", headers=_hdr(sa)).json() == []
    assert member.id in {
        uuid.UUID(m["id"]) for m in c.get("/auth/members", headers=_hdr(sa)).json()
    }
    # Back with their password; what they held before the removal is not.
    assert (
        c.post("/auth/login", json={"email": member.email, "password": PASSWORD}).status_code == 200
    )
    assert c.get("/auth/me", headers=old_token).status_code == 401
    assert (
        c.get("/auth/me", headers={"Authorization": f"Bearer {key.raw_token}"}).status_code == 401
    )
    assert c.post(f"/auth/members/{member.id}/restore", headers=_hdr(sa)).status_code == 404


def test_superadmin_sees_and_revokes_anyones_api_keys(db_session, world) -> None:
    c = _client(db_session)
    sa, admin, member = world["sa"], world["admin"], world["member"]
    key = ApiKeyService(db_session).create(user=admin, name="ci")
    other = ApiKeyService(db_session).create(user=member, name="script")
    bearer = {"Authorization": f"Bearer {key.raw_token}"}
    assert c.get("/auth/me", headers=bearer).status_code == 200

    assert c.get(f"/auth/members/{admin.id}/api-keys", headers=_hdr(admin)).status_code == 403
    keys = c.get(f"/auth/members/{admin.id}/api-keys", headers=_hdr(sa)).json()
    assert [k["name"] for k in keys] == ["ci"] and "token" not in keys[0]

    assert (
        c.delete(f"/auth/members/{admin.id}/api-keys/{other.key.id}", headers=_hdr(sa)).status_code
        == 404
    )
    assert (
        c.delete(f"/auth/members/{admin.id}/api-keys/{key.key.id}", headers=_hdr(sa)).status_code
        == 204
    )
    assert c.get("/auth/me", headers=bearer).status_code == 401
    assert c.get(f"/auth/members/{admin.id}/api-keys", headers=_hdr(sa)).json()[0]["revoked_at"]


def test_backups_are_listed_and_one_can_be_requested(
    db_session, world, tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path))
    for tier in ("daily", "weekly", "monthly"):
        (tmp_path / tier).mkdir()
    (tmp_path / "daily" / "carve-20261101-020008.sql.gz").write_bytes(b"x" * 10)
    (tmp_path / "monthly" / "carve-20261101-020008.sql.gz").write_bytes(b"x" * 10)
    c = _client(db_session)
    sa = world["sa"]

    assert c.get("/admin/backups", headers=_hdr(world["admin"])).status_code == 403
    assert c.post("/admin/backups/run", headers=_hdr(world["admin"])).status_code == 403
    body = c.get("/admin/backups", headers=_hdr(sa)).json()
    assert body["available"] and not body["running"] and body["requested_at"] is None
    assert sorted(f["tier"] for f in body["files"]) == ["daily", "monthly"]

    body = c.post("/admin/backups/run", headers=_hdr(sa)).json()
    assert body["requested_at"] is not None
    c.post("/admin/backups/run", headers=_hdr(sa))
    rows = (
        db_session.execute(select(AppSetting).where(AppSetting.key == "BACKUP_REQUESTED_AT"))
        .scalars()
        .all()
    )
    assert len(rows) == 1
    # The request is not a setting: the settings page does not list it.
    keys = {s["key"] for s in c.get("/admin/settings", headers=_hdr(sa)).json()["settings"]}
    assert "BACKUP_REQUESTED_AT" not in keys

    (tmp_path / "daily" / ".carve-20261101-130000.sql.gz.partial").write_bytes(b"")
    assert c.get("/admin/backups", headers=_hdr(sa)).json()["running"] is True
