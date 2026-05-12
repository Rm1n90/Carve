# Armin Mehri — mehri.armin@gmail.com
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.auth.schemas import CreateMemberIn, UserOut
from carve_api.auth.service import AuthService, EmailTaken
from carve_api.deps import (
    get_current_admin_user,
    get_current_user,
    get_db,
    require_role,
)

router = APIRouter(prefix="/auth/members", tags=["members"])


class RolePatchIn(BaseModel):
    role: UserRole


class MemberProjectOut(BaseModel):
    """One project a workspace member belongs to (owner / admin / etc.)."""

    project_id: str
    project_name: str
    role: str


@router.get(
    "/projects-by-user",
    response_model=dict[str, list[MemberProjectOut]],
)
def list_member_projects(
    _user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
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
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[UserOut]:
    """List every workspace member. v1 simplification: a single workspace
    so all authenticated users may read the directory; role changes still
    require admin (see ``patch_member_role``).

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
    actor: User = Depends(get_current_admin_user),  # noqa: ARG001
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
        new_user.role = UserRole(payload.role)
    db.commit()
    return UserOut.from_orm_user(new_user)


@router.patch("/{user_id}/role", response_model=UserOut)
def patch_member_role(
    user_id: uuid.UUID,
    payload: RolePatchIn,
    actor: User = Depends(require_role(UserRole.admin)),  # noqa: ARG001
    db: Session = Depends(get_db),
) -> UserOut:
    target = db.get(User, user_id)
    # Bug 14: soft-deleted users are 404 from this endpoint (the row exists
    # but is no longer part of the workspace).
    if target is None or target.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user_not_found")
    # Don't allow demoting the last admin — the workspace would be unmanageable.
    if target.role == UserRole.admin and payload.role != UserRole.admin:
        admins = (
            db.execute(
                select(User).where(
                    User.role == UserRole.admin, User.deleted_at.is_(None)
                )
            )
            .scalars()
            .all()
        )
        if len([a for a in admins if a.id != target.id]) == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="last_admin_cannot_be_demoted"
            )
    target.role = payload.role
    db.flush()
    db.commit()
    return UserOut.from_orm_user(target)


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
    if target.role == UserRole.admin:
        active_admins = (
            db.execute(
                select(User).where(
                    User.role == UserRole.admin, User.deleted_at.is_(None)
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
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
