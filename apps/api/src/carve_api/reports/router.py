# Armin Mehri — mehri.armin@gmail.com
"""Annotation counts by person (superadmin): who made how many
annotations, per project and task or per class.

An annotation counts for the person who created it, also when an AI run
they started made it; those carry the model's score and are counted
separately as ``from_ai``. Editing someone else's annotation does not
move it to the editor. Projects and tasks in the Trash are left out.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_db
from carve_api.permissions import superadmin_guard

router = APIRouter(prefix="/admin/reports", tags=["reports"])

# What each grouping selects and groups by; never built from input.
_GROUPS = {
    "task": ("t.id AS task_id, t.name AS task_name, NULL AS class_name", "t.id, t.name", ""),
    "class": (
        "NULL AS task_id, NULL AS task_name, c.name AS class_name",
        "c.name",
        "JOIN classes c ON c.id = a.class_id",
    ),
}


class AnnotationCountRow(BaseModel):
    project_id: uuid.UUID
    project_name: str
    task_id: uuid.UUID | None = None
    task_name: str | None = None
    class_name: str | None = None
    user_id: uuid.UUID | None
    email: str | None
    total: int
    # Made by an AI run (they carry a model score).
    from_ai: int
    # Images (or video frames) with at least one of these annotations.
    images: int


class AnnotationCounts(BaseModel):
    group_by: str
    since: datetime | None
    rows: list[AnnotationCountRow]


@router.get("/annotations", response_model=AnnotationCounts)
def annotation_counts(
    project_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    group_by: Literal["task", "class"] = "task",
    days: int | None = Query(None, ge=1, le=3650),
    _: User = Depends(superadmin_guard),
    db: Session = Depends(get_db),
) -> AnnotationCounts:
    select_cols, group_cols, join = _GROUPS[group_by]
    where = ["p.deleted_at IS NULL", "t.deleted_at IS NULL"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("p.id = :project_id")
        params["project_id"] = project_id
    if task_id is not None:
        where.append("t.id = :task_id")
        params["task_id"] = task_id
    since = None
    if days is not None:
        since = datetime.now(UTC) - timedelta(days=days)
        where.append("a.created_at >= :since")
        params["since"] = since
    sql = f"""
        SELECT p.id AS project_id, p.name AS project_name, {select_cols},
               a.created_by AS user_id,
               count(*) AS total, count(a.confidence) AS from_ai,
               count(DISTINCT a.frame_id) AS images
          FROM annotations a
          JOIN tasks t ON t.id = a.task_id
          JOIN projects p ON p.id = t.project_id
          {join}
         WHERE {" AND ".join(where)}
         GROUP BY p.id, p.name, {group_cols}, a.created_by
         ORDER BY total DESC
    """  # noqa: S608 — every interpolated part is a constant above
    rows = db.execute(text(sql), params).mappings().all()
    emails = dict(
        db.execute(
            select(User.id, User.email).where(
                User.id.in_({r["user_id"] for r in rows if r["user_id"]})
            )
        ).all()
    )
    return AnnotationCounts(
        group_by=group_by,
        since=since,
        rows=[AnnotationCountRow(**r, email=emails.get(r["user_id"])) for r in rows],
    )
