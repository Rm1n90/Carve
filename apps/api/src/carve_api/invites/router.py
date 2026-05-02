# Armin Mehri — mehri.armin@gmail.com
"""HTTP routes for the project invitation flow (Plan-13 Phase 7 Task 4).

Endpoints:
  * ``POST   /projects/{pid}/invites``               -- create  (owner/admin)
  * ``GET    /projects/{pid}/invites``               -- list pending
  * ``DELETE /projects/{pid}/invites/{id}``          -- revoke (owner/admin)
  * ``GET    /invites/{token}/preview``              -- public preview
  * ``POST   /invites/accept``                       -- accept (auth or self-register)
  * ``POST   /projects/{pid}/members/{uid}/role``    -- change role (owner/admin)
  * ``DELETE /projects/{pid}/members/{uid}``         -- remove (owner/admin)
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Response,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from carve_api.audit import service as audit_service
from carve_api.audit.actions import (
    PROJECT_MEMBER_ADDED,
    PROJECT_MEMBER_REMOVED,
    PROJECT_MEMBER_ROLE_CHANGED,
)
from carve_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from carve_api.auth.models import User
from carve_api.auth.service import AuthService
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.invites.schemas import (
    InviteAcceptIn,
    InviteAcceptOut,
    InviteAcceptUserOut,
    InviteCreateIn,
    InviteListItemOut,
    InviteOut,
    InvitePreviewOut,
    MemberRoleIn,
)
from carve_api.invites.service import (
    DuplicateInvite,
    EmailAlreadyMember,
    InviteAlreadyAccepted,
    InviteExpired,
    InviteNotFound,
    InviteService,
)
from carve_api.projects.models import Project, ProjectMember
from carve_api.projects.service import (
    _ADMIN_ROLES,
    require_project_role,
)


router = APIRouter(tags=["invites"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


# ---------------------------------------------------------------------
# Per-project invite CRUD (owner/admin)
# ---------------------------------------------------------------------


@router.post(
    "/projects/{project_id}/invites",
    response_model=InviteOut,
    status_code=status.HTTP_201_CREATED,
)
def create_invite(
    project_id: uuid.UUID,
    payload: InviteCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> InviteOut:
    try:
        project = require_project_role(db, user, project_id, _ADMIN_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    svc = InviteService(db)
    try:
        invite, raw_token = svc.create(
            project=project,
            email=str(payload.email),
            role=payload.role,
            invited_by=user,
        )
    except EmailAlreadyMember as exc:
        raise _http(exc) from exc
    except DuplicateInvite as exc:
        raise HTTPException(
            status_code=exc.http_status,
            detail={"error": exc.code, "existing_id": str(exc.existing_id)},
        ) from exc

    audit_service.record(
        db,
        actor_id=user.id,
        action="project_invite.created",
        target_type="project_invite",
        target_id=invite.id,
        project_id=project.id,
        summary=f"invited {invite.email} as {invite.role}",
        metadata={"email": invite.email, "role": invite.role},
    )
    db.commit()

    return InviteOut(
        id=invite.id,
        project_id=invite.project_id,
        email=invite.email,
        role=invite.role,
        token=raw_token,
        expires_at=invite.expires_at,
    )


@router.get(
    "/projects/{project_id}/invites",
    response_model=list[InviteListItemOut],
)
def list_invites(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[InviteListItemOut]:
    try:
        require_project_role(db, user, project_id)
    except AppError as exc:
        raise _http(exc) from exc

    rows = InviteService(db).list_pending(project_id=project_id)
    return [InviteListItemOut.model_validate(r) for r in rows]


@router.delete(
    "/projects/{project_id}/invites/{invite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke_invite(
    project_id: uuid.UUID,
    invite_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    try:
        require_project_role(db, user, project_id, _ADMIN_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    svc = InviteService(db)
    invite = svc.get_by_id(project_id=project_id, invite_id=invite_id)
    if invite is None:
        raise _http(InviteNotFound("invite_not_found"))
    try:
        svc.revoke(invite=invite)
    except InviteAlreadyAccepted as exc:
        raise _http(exc) from exc
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Public token preview + accept
# ---------------------------------------------------------------------


def _user_for_email(db: Session, email: str) -> "User | None":
    return db.execute(
        select(User).where(
            func.lower(User.email) == email.strip().lower(),
            User.deleted_at.is_(None),
        )
    ).scalar_one_or_none()


def _try_decode_caller(
    authorization: Optional[str], db: Session
) -> "User | None":
    """Best-effort decode of an optional Bearer token. Never raises."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    raw = authorization.split(" ", 1)[1].strip()
    try:
        claims = decode_token(raw, expected_type="access")
    except InvalidToken:
        return None
    sub = claims.get("sub")
    if not sub:
        return None
    try:
        user_id = uuid.UUID(sub)
    except (TypeError, ValueError):
        return None
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        return None
    return user


@router.get(
    "/invites/{token}/preview",
    response_model=InvitePreviewOut,
)
def preview_invite(
    token: str,
    db: Session = Depends(get_db),
) -> InvitePreviewOut:
    svc = InviteService(db)
    invite = svc.lookup_by_token(token)
    if invite is None:
        raise _http(InviteNotFound("invite_not_found"))
    try:
        svc.assert_acceptable(invite)
    except (InviteExpired, InviteAlreadyAccepted) as exc:
        raise _http(exc) from exc
    project = db.get(Project, invite.project_id)
    if project is None or project.deleted_at is not None:
        raise _http(InviteNotFound("invite_not_found"))
    existing = _user_for_email(db, invite.email)
    return InvitePreviewOut(
        project_id=project.id,
        project_name=project.name,
        email=invite.email,
        role=invite.role,
        requires_password=existing is None,
    )


@router.post("/invites/accept", response_model=InviteAcceptOut)
def accept_invite(
    payload: InviteAcceptIn,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> InviteAcceptOut:
    svc = InviteService(db)
    invite = svc.lookup_by_token(payload.token)
    if invite is None:
        raise _http(InviteNotFound("invite_not_found"))
    try:
        svc.assert_acceptable(invite)
    except (InviteExpired, InviteAlreadyAccepted) as exc:
        raise _http(exc) from exc

    existing_user = _user_for_email(db, invite.email)
    issued_jwt: str | None = None
    issued_refresh: str | None = None

    if existing_user is not None:
        # Path 1 -- existing user. Caller must be authenticated as them.
        caller = _try_decode_caller(authorization, db)
        if caller is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "requires_login", "email": invite.email},
            )
        if caller.id != existing_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "wrong_user", "email": invite.email},
            )
        target_user: User = existing_user
    else:
        # Path 2 -- new email; caller must register inline.
        if not payload.password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "password_required", "email": invite.email},
            )
        auth_svc = AuthService(db)
        target_user = auth_svc.register(
            email=invite.email, password=payload.password
        )
        issued_jwt = create_access_token(
            subject=str(target_user.id), role=target_user.role.value
        )
        issued_refresh = create_refresh_token(
            subject=str(target_user.id), role=target_user.role.value
        )

    # Idempotency: if a project_members row already exists, leave it
    # untouched and treat this as a successful accept.
    existing_member_role = db.execute(
        select(ProjectMember.role).where(
            ProjectMember.project_id == invite.project_id,
            ProjectMember.user_id == target_user.id,
        )
    ).scalar_one_or_none()
    if existing_member_role is None:
        db.add(
            ProjectMember(
                project_id=invite.project_id,
                user_id=target_user.id,
                role=invite.role,
                added_by=invite.invited_by,
            )
        )
        audit_service.record(
            db,
            actor_id=target_user.id,
            action=PROJECT_MEMBER_ADDED,
            target_type="project_member",
            target_id=target_user.id,
            project_id=invite.project_id,
            summary=f"{target_user.email} joined as {invite.role}",
            metadata={
                "email": target_user.email,
                "role": invite.role,
                "via_invite": str(invite.id),
            },
        )

    svc.mark_accepted(invite=invite, user=target_user)
    db.commit()

    return InviteAcceptOut(
        user=InviteAcceptUserOut(
            id=target_user.id,
            email=target_user.email,
            role=target_user.role.value,
        ),
        project_id=invite.project_id,
        role=invite.role,
        jwt=issued_jwt,
        refresh_token=issued_refresh,
    )


# ---------------------------------------------------------------------
# Per-project member role-change + remove (owner/admin)
# ---------------------------------------------------------------------


def _count_owners(db: Session, project_id: uuid.UUID) -> int:
    return int(
        db.execute(
            select(func.count())
            .select_from(ProjectMember)
            .where(
                ProjectMember.project_id == project_id,
                ProjectMember.role == "owner",
            )
        ).scalar_one()
    )


@router.post("/projects/{project_id}/members/{user_id}/role")
def change_member_role(
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: MemberRoleIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    try:
        require_project_role(db, user, project_id, _ADMIN_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "member_not_found"},
        )

    previous_role = member.role
    if previous_role == payload.role:
        return {"role": member.role}

    if previous_role == "owner" and payload.role != "owner":
        if _count_owners(db, project_id) <= 1:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"error": "last_owner"},
            )

    member.role = payload.role
    audit_service.record(
        db,
        actor_id=user.id,
        action=PROJECT_MEMBER_ROLE_CHANGED,
        target_type="project_member",
        target_id=user_id,
        project_id=project_id,
        summary=f"role {previous_role} -> {payload.role}",
        metadata={"from": previous_role, "to": payload.role},
    )
    db.commit()
    return {"role": member.role}


@router.delete(
    "/projects/{project_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_member(
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    try:
        require_project_role(db, user, project_id, _ADMIN_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "member_not_found"},
        )

    if member.role == "owner" and _count_owners(db, project_id) <= 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "last_owner"},
        )

    target_role = member.role
    target_email = db.execute(
        select(User.email).where(User.id == user_id)
    ).scalar_one_or_none() or ""

    db.delete(member)
    audit_service.record(
        db,
        actor_id=user.id,
        action=PROJECT_MEMBER_REMOVED,
        target_type="project_member",
        target_id=user_id,
        project_id=project_id,
        summary=f"removed {target_email or user_id}",
        metadata={"email": target_email, "role": target_role},
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
