# Armin Mehri — mehri.armin@gmail.com
"""HTTP surface for the singleton workspace (v3.1 Bug 6).

* ``GET /workspace`` — any authenticated user can read workspace metadata
  (the Settings → Workspace screen is also linked from the directory).
* ``PATCH /workspace`` — admin-only edit of ``name`` and ``description``;
  forbidden for ``member`` and ``viewer`` roles.

Audit Bug 6 retired the prior "Coming soon" placeholder in
``apps/web/src/pages/SettingsPages.tsx:803-823``; the frontend now
fetches/persists through these two endpoints.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_admin_user, get_current_user, get_db
from carve_api.workspace.models import Workspace
from carve_api.workspace.schemas import WorkspaceOut, WorkspaceUpdateIn
from carve_api.workspace.service import WorkspaceService

router = APIRouter(prefix="/workspace", tags=["workspace"])


def _members_count(db: Session) -> int:
    """Active (non-soft-deleted) member count. Mirrors the filter applied
    in ``members.router.list_members`` so the stat card matches the
    Members directory page."""
    count = db.scalar(
        select(func.count(User.id)).where(User.deleted_at.is_(None))
    )
    return int(count or 0)


def _serialize(ws: Workspace, *, members_count: int) -> WorkspaceOut:
    return WorkspaceOut(
        id=ws.id,
        name=ws.name,
        description=ws.description,
        created_at=ws.created_at,
        updated_at=ws.updated_at,
        members_count=members_count,
    )


@router.get("", response_model=WorkspaceOut)
def get_workspace(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    ws = WorkspaceService(db).get()
    return _serialize(ws, members_count=_members_count(db))


@router.patch("", response_model=WorkspaceOut)
def patch_workspace(
    payload: WorkspaceUpdateIn,
    _: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    ws = WorkspaceService(db).update(
        name=payload.name, description=payload.description
    )
    return _serialize(ws, members_count=_members_count(db))
