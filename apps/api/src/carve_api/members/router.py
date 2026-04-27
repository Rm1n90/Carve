import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.auth.schemas import UserOut
from carve_api.deps import get_current_user, get_db, require_role

router = APIRouter(prefix="/auth/members", tags=["members"])


class RolePatchIn(BaseModel):
    role: UserRole


@router.get("", response_model=list[UserOut])
def list_members(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth required
    db: Session = Depends(get_db),
) -> list[UserOut]:
    """List every workspace member. v1 simplification: a single workspace
    so all authenticated users may read the directory; role changes still
    require admin (see ``patch_member_role``).
    """
    rows = list(db.execute(select(User).order_by(User.created_at)).scalars())
    return [UserOut.from_orm_user(u) for u in rows]


@router.patch("/{user_id}/role", response_model=UserOut)
def patch_member_role(
    user_id: uuid.UUID,
    payload: RolePatchIn,
    actor: User = Depends(require_role(UserRole.admin)),  # noqa: ARG001
    db: Session = Depends(get_db),
) -> UserOut:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user_not_found")
    # Don't allow demoting the last admin — the workspace would be unmanageable.
    if target.role == UserRole.admin and payload.role != UserRole.admin:
        admins = db.execute(select(User).where(User.role == UserRole.admin)).scalars().all()
        if len([a for a in admins if a.id != target.id]) == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="last_admin_cannot_be_demoted"
            )
    target.role = payload.role
    db.flush()
    db.commit()
    return UserOut.from_orm_user(target)
