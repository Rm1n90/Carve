# Armin Mehri — mehri.armin@gmail.com
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.audit import service as audit_service
from carve_api.audit.actions import (
    USER_BLOCKED,
    USER_CREATED,
    USER_DELETED,
    USER_PASSWORD_RESET,
    USER_ROLE_CHANGED,
    USER_SESSIONS_REVOKED,
    USER_UNBLOCKED,
)
from carve_api.auth.models import ADMIN_LEVEL_ROLES, User, UserRole
from carve_api.auth.schemas import (
    BlockUserIn,
    CreateMemberIn,
    SetPasswordIn,
    UserOut,
)
from carve_api.auth.service import AuthService, EmailTaken
from carve_api.deps import get_current_admin_user, get_db
from carve_api.permissions import can_manage_user, require_superadmin

router = APIRouter(prefix="/auth/members", tags=["members"])


class RolePatchIn(BaseModel):
    role: UserRole


class MemberProjectOut(BaseModel):
    """One project a workspace member belongs to (owner / admin / etc.)."""

    project_id: str
    project_name: str
    role: str


# Outsourcing hardening — the roster and the per-user project map tell a
# member the whole team and the whole project structure. Both are
# admin-only; the only UI that reads them (Settings -> Members, and the
# Datasets tab) is admin-only too.
@router.get(
    "/projects-by-user",
    response_model=dict[str, list[MemberProjectOut]],
)
def list_member_projects(
    _user: User = Depends(get_current_admin_user),  # noqa: ARG001 — admin gate
    db: Session = Depends(get_db),
) -> dict[str, list[MemberProjectOut]]:
    """Return per-user project memberships keyed by user id (string).

    Drives the Settings → Members page so an admin can see WHICH
    projects every member has access to, instead of just the email +
    workspace role. One round-trip for the whole workspace (small data
    even for a 100-user / 100-project shop, which is well within v1
    operating envelope).
    """
    from carve_api.projects.models import Project, ProjectMember

    rows = db.execute(
        select(ProjectMember, Project.name)
        .join(Project, Project.id == ProjectMember.project_id)
        .order_by(ProjectMember.user_id, Project.name)
    ).all()
    out: dict[str, list[MemberProjectOut]] = {}
    for pm, project_name in rows:
        out.setdefault(str(pm.user_id), []).append(
            MemberProjectOut(
                project_id=str(pm.project_id),
                project_name=project_name,
                role=pm.role,
            )
        )
    return out


@router.get("", response_model=list[UserOut])
def list_members(
    user: User = Depends(get_current_admin_user),  # noqa: ARG001 — admin gate
    db: Session = Depends(get_db),
) -> list[UserOut]:
    """List every workspace member. Admin-only.

    Outsourcing hardening — this used to be readable by any authenticated
    user ("v1 simplification: a single workspace"). That handed an
    outsourced annotator the entire team roster: every colleague's email
    address, and with ``projects-by-user`` the whole project structure
    too. Neither is any of their business, and the only screens that read
    it (Settings → Members, the Datasets tab) are already admin-only.

    Bug 14: soft-deleted users are excluded — once an admin removes them
    they vanish from the directory.
    """
    rows = list(
        db.execute(
            select(User)
            .where(User.deleted_at.is_(None))
            .order_by(User.created_at)
        ).scalars()
    )
    return [UserOut.from_orm_user(u) for u in rows]


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=UserOut,
)
def create_member(
    payload: CreateMemberIn,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UserOut:
    """Bug 14: admin creates a member with email + initial password + role.

    Replaces the old "ask an admin to register at /register while
    authenticated" workaround documented in SettingsMembersPage. The new
    UI in Settings -> Members opens a dialog that posts here.

    Returns 409 ``email_taken`` if the email is already used by an active
    user; 403 if the caller is not an admin (enforced by dependency).
    """
    service = AuthService(db)
    if service.email_exists(payload.email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email_taken"
        )
    try:
        new_user = service.register(
            email=payload.email, password=payload.password
        )
    except EmailTaken as exc:  # defence in depth — race between checks
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email_taken"
        ) from exc
    # ``register`` defaults the second-and-later user to UserRole.member,
    # so we only override when the admin explicitly picked a different role.
    if payload.role:
        requested = UserRole(payload.role)
        # Only a superadmin may create an admin-level account. Without
        # this an admin could mint a peer and the superadmin tier would
        # be decorative.
        if requested in ADMIN_LEVEL_ROLES:
            require_superadmin(actor)
        new_user.role = requested
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_CREATED,
        target_type="user",
        target_id=new_user.id,
        project_id=None,
        summary=f"created {new_user.email} as {new_user.role.value}",
    )
    db.commit()
    return UserOut.from_orm_user(new_user)


@router.patch("/{user_id}/role", response_model=UserOut)
def patch_member_role(
    user_id: uuid.UUID,
    payload: RolePatchIn,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UserOut:
    """Change a user's workspace role.

    Admins may re-role members and viewers. Granting or revoking an
    admin-level role — and touching an admin-level account at all — is
    superadmin-only, which is what stops any admin from minting a peer.
    """
    target = _target_or_404(db, user_id)
    _require_can_manage(actor, target)
    # Promoting *into* the admin tier is as privileged as touching
    # someone already in it.
    if payload.role in ADMIN_LEVEL_ROLES:
        require_superadmin(actor)
    _guard_last_superadmin(db, target, leaving=payload.role != UserRole.superadmin)
    previous = target.role
    target.role = payload.role
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_ROLE_CHANGED,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"{target.email}: {previous.value} → {payload.role.value}",
    )
    db.flush()
    db.commit()
    return UserOut.from_orm_user(target)


# ---------------------------------------------------------------------------
# Superadmin account controls (alembic 0039)
# ---------------------------------------------------------------------------


@router.post("/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def set_member_password(
    user_id: uuid.UUID,
    payload: SetPasswordIn,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Response:
    """Set another user's password without knowing the current one.

    Superadmin-only. Every existing session of the target is revoked at
    the same moment — a reset that leaves the old browser tab logged in
    is not a reset. The target is not notified by Carve; tell them out
    of band.
    """
    require_superadmin(actor)
    target = _target_or_404(db, user_id)
    if target.id == actor.id:
        # Superadmins rotate their own password through the normal
        # self-serve endpoint, which verifies the current one.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="use_self_service_password_change",
        )
    AuthService(db).force_set_password(target, new_password=payload.new_password)
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_PASSWORD_RESET,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"password reset for {target.email}; sessions revoked",
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{user_id}/block", response_model=UserOut)
def block_member(
    user_id: uuid.UUID,
    payload: BlockUserIn | None = None,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UserOut:
    """Block an account.

    Superadmin-only, and reversible — unlike deletion, blocking keeps
    the user's annotations attributed and lets you restore access with
    one call. Takes effect on the target's very next request, because
    every authenticated request re-reads the row.
    """
    require_superadmin(actor)
    target = _target_or_404(db, user_id)
    if target.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="cannot_block_self"
        )
    _guard_last_superadmin(db, target, leaving=True)
    reason = payload.reason if payload is not None else None
    target.blocked_at = datetime.now(timezone.utc)
    target.blocked_by = actor.id
    target.blocked_reason = reason
    # Blocking also drops live sessions, so the user does not keep
    # working until their token happens to expire.
    AuthService(db).revoke_sessions(target)
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_BLOCKED,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"blocked {target.email}" + (f": {reason}" if reason else ""),
    )
    db.commit()
    return UserOut.from_orm_user(target)


@router.post("/{user_id}/unblock", response_model=UserOut)
def unblock_member(
    user_id: uuid.UUID,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> UserOut:
    """Restore a blocked account. The user must log in again."""
    require_superadmin(actor)
    target = _target_or_404(db, user_id)
    target.blocked_at = None
    target.blocked_by = None
    target.blocked_reason = None
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_UNBLOCKED,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"unblocked {target.email}",
    )
    db.commit()
    return UserOut.from_orm_user(target)


@router.post("/{user_id}/revoke-sessions", status_code=status.HTTP_204_NO_CONTENT)
def revoke_member_sessions(
    user_id: uuid.UUID,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Response:
    """Force-logout: invalidate every token the user currently holds.

    Superadmin-only. The account stays active — the person can simply
    log in again — so this is the tool for "their laptop was stolen",
    not for "they should not be here any more" (that is ``block``).
    """
    require_superadmin(actor)
    target = _target_or_404(db, user_id)
    AuthService(db).revoke_sessions(target)
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_SESSIONS_REVOKED,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"revoked all sessions for {target.email}",
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------


def _target_or_404(db: Session, user_id: uuid.UUID) -> User:
    """Soft-deleted users are 404 here: the row exists but the person is
    no longer part of the workspace."""
    target = db.get(User, user_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="user_not_found"
        )
    return target


def _require_can_manage(actor: User, target: User) -> None:
    """Admins manage members/viewers; only a superadmin manages the
    admin tier. Self-management through this surface is always refused."""
    if not can_manage_user(actor, target):
        if target.id == actor.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="cannot_target_self"
            )
        require_superadmin(actor)


def _guard_last_superadmin(db: Session, target: User, *, leaving: bool) -> None:
    """Refuse to leave the workspace with no superadmin.

    The last superadmin cannot be demoted, blocked or deleted — there
    would be nobody left who could manage admins, reset a password or
    undo the change.
    """
    if not leaving or target.role != UserRole.superadmin:
        return
    remaining = db.execute(
        select(User.id).where(
            User.role == UserRole.superadmin,
            User.deleted_at.is_(None),
            User.blocked_at.is_(None),
            User.id != target.id,
        )
    ).first()
    if remaining is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="last_superadmin_protected",
        )


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_member(
    user_id: uuid.UUID,
    actor: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> Response:
    """Bug 14: soft-delete a member. Subsequent GETs exclude them and any
    JWT or PAT they hold becomes invalid (see deps.get_current_user and
    api_keys.service.authenticate)."""
    target = db.get(User, user_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if target.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="cannot_delete_self"
        )
    # Deleting an admin-level account is superadmin-only; admins may only
    # remove members and viewers.
    _require_can_manage(actor, target)
    _guard_last_superadmin(db, target, leaving=True)
    # ``in ADMIN_LEVEL_ROLES`` rather than ``== UserRole.admin``: this is a
    # guard trigger, not a permission check, and the superadmin case is
    # already covered by ``_guard_last_superadmin`` above — but leaving a
    # bare equality here invites the next reader to copy the one pattern
    # that silently excludes the top tier.
    if target.role in ADMIN_LEVEL_ROLES:
        active_admins = (
            db.execute(
                select(User).where(
                    User.role.in_(ADMIN_LEVEL_ROLES), User.deleted_at.is_(None)
                )
            )
            .scalars()
            .all()
        )
        if len(active_admins) <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cannot_delete_last_admin",
            )
    target.deleted_at = datetime.now(timezone.utc)
    audit_service.record(
        db,
        actor_id=actor.id,
        action=USER_DELETED,
        target_type="user",
        target_id=target.id,
        project_id=None,
        summary=f"removed {target.email} ({target.role.value})",
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
