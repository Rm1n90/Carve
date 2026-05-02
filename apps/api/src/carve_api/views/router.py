# Armin Mehri — mehri.armin@gmail.com
"""HTTP routes for saved views (Plan-13 Phase 7 Task 8).

  * ``POST   /tasks/{tid}/views``  -- create  (project member|admin|owner)
  * ``GET    /tasks/{tid}/views``  -- list    (any project read role)
  * ``PATCH  /views/{id}``         -- update  (owner or project admin/owner)
  * ``DELETE /views/{id}``         -- remove  (owner or project admin/owner)
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import Task
from carve_api.projects.service import (
    _ADMIN_ROLES,
    _MUTATING_ROLES,
    _READ_ROLES,
    get_project_role,
    require_project_role,
)
from carve_api.views import service as views_service
from carve_api.views.schemas import SavedViewIn, SavedViewOut, SavedViewPatch


router = APIRouter(tags=["views"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _resolve_task(db: Session, task_id: uuid.UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.deleted_at is not None:
        raise HTTPException(status_code=404, detail="task_not_found")
    return task


@router.post(
    "/tasks/{task_id}/views",
    response_model=SavedViewOut,
    status_code=status.HTTP_201_CREATED,
)
def create_view(
    task_id: uuid.UUID,
    payload: SavedViewIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SavedViewOut:
    task = _resolve_task(db, task_id)
    try:
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    row = views_service.create(
        db,
        task_id=task.id,
        owner_id=user.id,
        name=payload.name,
        query=payload.query,
        shared=payload.shared,
    )
    db.commit()
    return SavedViewOut.model_validate(row)


@router.get(
    "/tasks/{task_id}/views",
    response_model=list[SavedViewOut],
)
def list_views(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SavedViewOut]:
    task = _resolve_task(db, task_id)
    try:
        require_project_role(db, user, task.project_id, _READ_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    rows = views_service.list_for_task(
        db, task_id=task.id, viewer_id=user.id
    )
    return [SavedViewOut.model_validate(r) for r in rows]


def _can_edit_view(db: Session, user: User, view) -> bool:
    """Owner can always edit. Project admins/owners can edit anyone's view."""
    if view.owner == user.id:
        return True
    task = db.get(Task, view.task_id)
    if task is None:
        return False
    role = get_project_role(db, user.id, task.project_id)
    return role in _ADMIN_ROLES


@router.patch("/views/{view_id}", response_model=SavedViewOut)
def patch_view(
    view_id: uuid.UUID,
    payload: SavedViewPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SavedViewOut:
    view = views_service.get(db, view_id)
    if view is None:
        raise HTTPException(status_code=404, detail="view_not_found")
    if not _can_edit_view(db, user, view):
        raise HTTPException(status_code=403, detail="forbidden")
    updated = views_service.update(
        db,
        view=view,
        name=payload.name,
        query=payload.query,
        shared=payload.shared,
    )
    db.commit()
    return SavedViewOut.model_validate(updated)


@router.delete(
    "/views/{view_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_view(
    view_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    view = views_service.get(db, view_id)
    if view is None:
        raise HTTPException(status_code=404, detail="view_not_found")
    if not _can_edit_view(db, user, view):
        raise HTTPException(status_code=403, detail="forbidden")
    views_service.delete_view(db, view=view)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
