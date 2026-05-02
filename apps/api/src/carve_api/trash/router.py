# Armin Mehri — mehri.armin@gmail.com
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.deps import get_current_user, get_db, require_role
from carve_api.projects.models import Project, Task

router = APIRouter(prefix="/trash", tags=["trash"])


class TrashItem(BaseModel):
    kind: Literal["project", "task"]
    id: str
    name: str
    project_id: str | None
    deleted_at: datetime


class TrashList(BaseModel):
    items: list[TrashItem]


def _project_visible(actor: User, p: Project) -> bool:
    return actor.role == UserRole.admin or p.owner_id == actor.id


@router.get("", response_model=TrashList)
def list_trash(
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrashList:
    items: list[TrashItem] = []
    project_rows = list(
        db.execute(
            select(Project)
            .where(Project.deleted_at.is_not(None))
            .order_by(Project.deleted_at.desc())
        ).scalars()
    )
    for p in project_rows:
        if not _project_visible(actor, p):
            continue
        items.append(
            TrashItem(
                kind="project",
                id=str(p.id),
                name=p.name,
                project_id=None,
                deleted_at=p.deleted_at,
            )
        )

    task_rows = list(
        db.execute(
            select(Task)
            .where(Task.deleted_at.is_not(None))
            .order_by(Task.deleted_at.desc())
        ).scalars()
    )
    for t in task_rows:
        # A task is visible if its parent project is visible.
        parent = db.get(Project, t.project_id)
        if parent is None or not _project_visible(actor, parent):
            continue
        items.append(
            TrashItem(
                kind="task",
                id=str(t.id),
                name=t.name,
                project_id=str(t.project_id),
                deleted_at=t.deleted_at,
            )
        )

    items.sort(key=lambda i: i.deleted_at, reverse=True)
    return TrashList(items=items)


@router.post("/{kind}/{item_id}/restore", status_code=status.HTTP_204_NO_CONTENT)
def restore_item(
    kind: Literal["project", "task"],
    item_id: uuid.UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if kind == "project":
        p = db.get(Project, item_id)
        if p is None or p.deleted_at is None:
            raise HTTPException(status_code=404, detail="not_found")
        if not _project_visible(actor, p):
            raise HTTPException(status_code=403, detail="forbidden")
        p.deleted_at = None
    else:
        t = db.get(Task, item_id)
        if t is None or t.deleted_at is None:
            raise HTTPException(status_code=404, detail="not_found")
        parent = db.get(Project, t.project_id)
        if parent is None or not _project_visible(actor, parent):
            raise HTTPException(status_code=403, detail="forbidden")
        t.deleted_at = None
    db.flush()
    db.commit()


@router.delete("/{kind}/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def hard_delete_item(
    kind: Literal["project", "task"],
    item_id: uuid.UUID,
    actor: User = Depends(require_role(UserRole.admin)),  # noqa: ARG001
    db: Session = Depends(get_db),
) -> None:
    """Permanent delete. Admin-only — this drops the row entirely along with
    its cascading children (assets/annotations via FK ``ON DELETE CASCADE``)."""
    if kind == "project":
        p = db.get(Project, item_id)
        if p is None:
            raise HTTPException(status_code=404, detail="not_found")
        db.delete(p)
    else:
        t = db.get(Task, item_id)
        if t is None:
            raise HTTPException(status_code=404, detail="not_found")
        db.delete(t)
    db.flush()
    db.commit()
