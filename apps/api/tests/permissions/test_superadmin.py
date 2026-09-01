"""SuperAdmin tier — account controls and the escalation boundary.

The workspace previously had a flat admin role: every admin could
promote, demote and delete every other admin, so "admin" was really
"can grant themselves anything". ``superadmin`` closes that, and adds
the account controls nobody had: reset another user's password, block
an account, force-logout, purge the trash, freeze a project.

The most important property under test is the one that is easy to get
backwards — a superadmin must never hold FEWER permissions than an
admin. Several checks in this codebase compared against ``UserRole.admin``
directly; every one of them had to move to ``ADMIN_LEVEL_ROLES``.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from carve_api.auth.jwt import create_access_token
from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password, verify_password
from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.projects.models import (
    Class,
    Project,
    ProjectMember,
    Task,
    TaskKind,
)


def _client(db_session) -> TestClient:
    app = create_app()

    def _ov():
        yield db_session

    app.dependency_overrides[get_db] = _ov
    return TestClient(app)


def _hdr(u: User) -> dict[str, str]:
    return {
        "Authorization": (
            f"Bearer {create_access_token(subject=str(u.id), role=u.role.value)}"
        )
    }


def _mk(db_session, label: str, role: UserRole) -> User:
    u = User(
        email=f"{label}-{uuid.uuid4().hex[:6]}@sa.example.com",
        password_hash=hash_password("original-pass"),
        role=role,
    )
    db_session.add(u)
    db_session.flush()
    return u


@pytest.fixture()
def world(db_session) -> dict:
    sa = _mk(db_session, "super", UserRole.superadmin)
    admin = _mk(db_session, "admin", UserRole.admin)
    admin2 = _mk(db_session, "admin2", UserRole.admin)
    member = _mk(db_session, "member", UserRole.member)
    project = Project(name="P", owner_id=sa.id)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        ProjectMember(project_id=project.id, user_id=member.id, role="member")
    )
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    klass = Class(
        project_id=project.id, idx=0, name="car", color="#ff0000", attributes={}
    )
    db_session.add_all([task, klass])
    db_session.flush()
    return {
        "sa": sa, "admin": admin, "admin2": admin2,
        "member": member, "project": project, "task": task, "klass": klass,
    }


# ---------- the tier must inherit everything admin has ---------------------


def test_superadmin_is_treated_as_admin_everywhere(db_session, world):
    """Regression guard for the whole class of bug this refactor fixed:
    a bare ``role == UserRole.admin`` silently excludes superadmins."""
    c = _client(db_session)
    hdr = _hdr(world["sa"])
    for url in ("/admin/ping", "/jobs", "/system/info", "/weights", "/auth/members"):
        r = c.get(url, headers=hdr)
        assert r.status_code != 403, f"{url} wrongly refused a superadmin: {r.text}"


def test_superadmin_keeps_admin_only_capabilities(db_session, world):
    """Export is admin-gated; the tier above admin must pass it too."""
    c = _client(db_session)
    r = c.get(f"/tasks/{world['task'].id}/annotation-kinds", headers=_hdr(world["sa"]))
    assert r.status_code != 403


# ---------- password reset -------------------------------------------------


def test_superadmin_resets_another_users_password(db_session, world):
    c = _client(db_session)
    target = world["member"]
    r = c.post(
        f"/auth/members/{target.id}/password",
        json={"new_password": "brand-new-pass"},
        headers=_hdr(world["sa"]),
    )
    assert r.status_code == 204
    db_session.refresh(target)
    assert verify_password("brand-new-pass", target.password_hash)
    # and the old password no longer works
    assert not verify_password("original-pass", target.password_hash)


def test_admin_cannot_reset_passwords(db_session, world):
    c = _client(db_session)
    r = c.post(
        f"/auth/members/{world['member'].id}/password",
        json={"new_password": "brand-new-pass"},
        headers=_hdr(world["admin"]),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "superadmin_only"


def test_password_reset_revokes_existing_sessions(db_session, world):
    """A reset that leaves the target's old token working is not a reset."""
    c = _client(db_session)
    target = world["member"]
    stale = _hdr(target)
    assert c.get("/auth/me", headers=stale).status_code == 200

    c.post(
        f"/auth/members/{target.id}/password",
        json={"new_password": "brand-new-pass"},
        headers=_hdr(world["sa"]),
    )
    r = c.get("/auth/me", headers=stale)
    assert r.status_code == 401
    assert r.json()["error"] == "session_revoked"


# ---------- blocking -------------------------------------------------------


def test_block_takes_effect_on_the_next_request(db_session, world):
    c = _client(db_session)
    target = world["member"]
    token = _hdr(target)
    assert c.get("/auth/me", headers=token).status_code == 200

    r = c.post(
        f"/auth/members/{target.id}/block",
        json={"reason": "contract ended"},
        headers=_hdr(world["sa"]),
    )
    assert r.status_code == 200
    assert r.json()["blocked"] is True

    r = c.get("/auth/me", headers=token)
    assert r.status_code == 403
    assert r.json()["error"] == "account_blocked"


def test_blocked_user_cannot_log_in_and_is_told_why(db_session, world):
    c = _client(db_session)
    target = world["member"]
    c.post(
        f"/auth/members/{target.id}/block",
        json={"reason": "contract ended"},
        headers=_hdr(world["sa"]),
    )
    r = c.post(
        "/auth/login",
        json={"email": target.email, "password": "original-pass"},
    )
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "account_blocked"
    assert body["reason"] == "contract ended"


def test_blocked_user_cannot_refresh_into_a_new_session(db_session, world):
    """The refresh endpoint would otherwise be a bypass."""
    from carve_api.auth.jwt import create_refresh_token

    c = _client(db_session)
    target = world["member"]
    refresh = create_refresh_token(subject=str(target.id), role=target.role.value)
    assert c.post("/auth/refresh", json={"refresh_token": refresh}).status_code == 200

    c.post(f"/auth/members/{target.id}/block", headers=_hdr(world["sa"]))
    r = c.post("/auth/refresh", json={"refresh_token": refresh})
    assert r.status_code in (401, 403)


def test_unblock_restores_access(db_session, world):
    c = _client(db_session)
    target = world["member"]
    c.post(f"/auth/members/{target.id}/block", headers=_hdr(world["sa"]))
    r = c.post(f"/auth/members/{target.id}/unblock", headers=_hdr(world["sa"]))
    assert r.status_code == 200
    assert r.json()["blocked"] is False
    assert c.post(
        "/auth/login",
        json={"email": target.email, "password": "original-pass"},
    ).status_code == 200


def test_admin_cannot_block(db_session, world):
    c = _client(db_session)
    r = c.post(
        f"/auth/members/{world['member'].id}/block", headers=_hdr(world["admin"])
    )
    assert r.status_code == 403


# ---------- the escalation boundary ---------------------------------------


def test_admin_cannot_promote_anyone_to_admin(db_session, world):
    """The whole point of the tier: no admin may mint a peer."""
    c = _client(db_session)
    r = c.patch(
        f"/auth/members/{world['member'].id}/role",
        json={"role": "admin"},
        headers=_hdr(world["admin"]),
    )
    assert r.status_code == 403
    assert r.json()["error"] == "superadmin_only"


def test_admin_cannot_touch_another_admin(db_session, world):
    c = _client(db_session)
    hdr = _hdr(world["admin"])
    assert c.patch(
        f"/auth/members/{world['admin2'].id}/role",
        json={"role": "member"}, headers=hdr,
    ).status_code == 403
    assert c.delete(
        f"/auth/members/{world['admin2'].id}", headers=hdr
    ).status_code == 403


def test_admin_can_still_manage_members(db_session, world):
    """Admins keep the day-to-day user management they had."""
    c = _client(db_session)
    r = c.patch(
        f"/auth/members/{world['member'].id}/role",
        json={"role": "viewer"},
        headers=_hdr(world["admin"]),
    )
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


def test_superadmin_can_promote_and_demote_admins(db_session, world):
    c = _client(db_session)
    hdr = _hdr(world["sa"])
    assert c.patch(
        f"/auth/members/{world['member'].id}/role",
        json={"role": "admin"}, headers=hdr,
    ).status_code == 200
    assert c.patch(
        f"/auth/members/{world['admin2'].id}/role",
        json={"role": "member"}, headers=hdr,
    ).status_code == 200


def test_nobody_can_act_on_their_own_account(db_session, world):
    c = _client(db_session)
    r = c.patch(
        f"/auth/members/{world['sa'].id}/role",
        json={"role": "member"},
        headers=_hdr(world["sa"]),
    )
    assert r.status_code == 400
    assert r.json()["error"] == "cannot_target_self"


def test_superadmin_cannot_be_touched_by_an_admin(db_session, world):
    c = _client(db_session)
    r = c.post(
        f"/auth/members/{world['sa'].id}/block", headers=_hdr(world["admin"])
    )
    assert r.status_code == 403


# ---------- project suspension --------------------------------------------


def test_suspended_project_is_read_only_for_everyone_below_superadmin(
    db_session, world
):
    c = _client(db_session)
    pid, tid = world["project"].id, world["task"].id
    assert c.post(f"/projects/{pid}/suspend", headers=_hdr(world["sa"])).status_code == 200

    member_hdr = _hdr(world["member"])
    # reads still work — suspension preserves data, it does not hide it
    assert c.get(f"/tasks/{tid}/annotations", headers=member_hdr).status_code == 200
    # writes are refused
    r = c.patch(
        f"/projects/{pid}/tasks/{tid}",
        json={"name": "renamed"},
        headers=member_hdr,
    )
    assert r.status_code == 409
    assert r.json()["error"] == "project_suspended"


def test_suspension_blocks_annotation_writes(db_session, world):
    """Annotation writes never pass through ``require_project_role``, so
    they need the check on the task path — the case most likely to be
    missed."""
    from carve_api.assets.models import Asset, AssetKind, Frame

    c = _client(db_session)
    a = Asset(
        task_id=world["task"].id, kind=AssetKind.image, xxh3_128="h",
        mime="image/png", size_bytes=1, width=8, height=8, frames=1,
        original_name="a.png",
    )
    db_session.add(a)
    db_session.flush()
    fr = Frame(asset_id=a.id, idx=0)
    db_session.add(fr)
    db_session.flush()

    c.post(f"/projects/{world['project'].id}/suspend", headers=_hdr(world["sa"]))
    r = c.post(
        f"/tasks/{world['task'].id}/annotations",
        json={
            "frame_id": str(fr.id), "class_id": str(world["klass"].id),
            "kind": "bbox", "geometry": {"x": 1, "y": 1, "w": 2, "h": 2},
        },
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"] == "project_suspended"


def test_superadmin_can_still_write_to_a_suspended_project(db_session, world):
    """The freeze must never be a dead end for the person who set it."""
    c = _client(db_session)
    pid, tid = world["project"].id, world["task"].id
    c.post(f"/projects/{pid}/suspend", headers=_hdr(world["sa"]))
    r = c.patch(
        f"/projects/{pid}/tasks/{tid}",
        json={"name": "corrected"},
        headers=_hdr(world["sa"]),
    )
    assert r.status_code == 200


def test_unsuspend_restores_writes(db_session, world):
    c = _client(db_session)
    pid, tid = world["project"].id, world["task"].id
    c.post(f"/projects/{pid}/suspend", headers=_hdr(world["sa"]))
    c.post(f"/projects/{pid}/unsuspend", headers=_hdr(world["sa"]))
    r = c.patch(
        f"/projects/{pid}/tasks/{tid}",
        json={"name": "ok"},
        headers=_hdr(world["member"]),
    )
    assert r.status_code == 200


def test_admin_cannot_suspend(db_session, world):
    c = _client(db_session)
    r = c.post(
        f"/projects/{world['project'].id}/suspend", headers=_hdr(world["admin"])
    )
    assert r.status_code == 403


# ---------- audit + trash --------------------------------------------------


def test_account_controls_are_audited_and_visible_to_superadmin(db_session, world):
    c = _client(db_session)
    c.post(
        f"/auth/members/{world['member'].id}/block",
        json={"reason": "contract ended"},
        headers=_hdr(world["sa"]),
    )
    r = c.get("/audit", headers=_hdr(world["sa"]))
    assert r.status_code == 200
    actions = {e["action"] for e in r.json()["items"]}
    assert "user.blocked" in actions


def test_workspace_audit_is_superadmin_only(db_session, world):
    c = _client(db_session)
    assert c.get("/audit", headers=_hdr(world["admin"])).status_code == 403
    assert c.get("/audit", headers=_hdr(world["member"])).status_code == 403


def test_trash_purge_is_superadmin_only(db_session, world):
    c = _client(db_session)
    url = f"/trash/task/{world['task'].id}"
    assert c.delete(url, headers=_hdr(world["admin"])).status_code == 403
    assert c.delete(url, headers=_hdr(world["member"])).status_code == 403
