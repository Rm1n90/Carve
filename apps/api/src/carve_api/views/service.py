# Armin Mehri — mehri.armin@gmail.com
"""Service helpers for the saved-views API (Plan-13 Phase 7 Task 8)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from carve_api.views.models import SavedView


def list_for_task(
    db: Session, *, task_id: uuid.UUID, viewer_id: uuid.UUID
) -> list[SavedView]:
    stmt = (
        select(SavedView)
        .where(SavedView.task_id == task_id)
        .where(or_(SavedView.owner == viewer_id, SavedView.shared.is_(True)))
        .order_by(SavedView.created_at.desc())
    )
    return list(db.execute(stmt).scalars())


def create(
    db: Session,
    *,
    task_id: uuid.UUID,
    owner_id: uuid.UUID,
    name: str,
    query: dict[str, Any],
    shared: bool,
) -> SavedView:
    row = SavedView(
        task_id=task_id,
        owner=owner_id,
        name=name,
        query=query,
        shared=shared,
    )
    db.add(row)
    db.flush()
    return row


def get(db: Session, view_id: uuid.UUID) -> SavedView | None:
    return db.get(SavedView, view_id)


def update(
    db: Session,
    *,
    view: SavedView,
    name: str | None,
    query: dict[str, Any] | None,
    shared: bool | None,
) -> SavedView:
    if name is not None:
        view.name = name
    if query is not None:
        view.query = query
    if shared is not None:
        view.shared = shared
    db.flush()
    return view


def delete_view(db: Session, *, view: SavedView) -> None:
    db.delete(view)
    db.flush()
