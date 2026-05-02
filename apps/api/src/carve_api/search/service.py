"""Search service (Plan-13 Phase 7 Task 8).

Workspace-wide asset search bounded by project membership. Substring
match on ``original_name`` (case-insensitive) is the only matching
mode for now -- annotation note full-text is reserved for a future
extension. Cursor pagination uses base64 of the last seen
``(created_at, asset_id)`` pair, mirroring ``audit/router._encode_cursor``.
"""

from __future__ import annotations

import base64
import binascii
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project, ProjectMember, Task


def _encode_cursor(created_at: datetime, asset_id: uuid.UUID) -> str:
    raw = f"{created_at.isoformat()}|{asset_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID] | None:
    pad = "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(cursor + pad).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    ts_part, _, id_part = raw.partition("|")
    if not ts_part or not id_part:
        return None
    try:
        ts = datetime.fromisoformat(ts_part)
        rid = uuid.UUID(id_part)
    except ValueError:
        return None
    return ts, rid


def search_assets(
    db: Session,
    *,
    actor: User,
    q: str | None = None,
    workspace: bool = False,
    project_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    kind: str | None = None,
    class_id: uuid.UUID | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    status: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Run the workspace asset search.

    Returns ``(items, next_cursor)``. Workspace admins (``UserRole.admin``)
    see every project; everyone else is restricted to projects where
    they hold a ``project_members`` row.
    """
    _ = workspace  # reserved -- see module docstring

    stmt = (
        select(Asset, Project, Task)
        .join(Task, Task.id == Asset.task_id)
        .join(Project, Project.id == Task.project_id)
        .where(
            Project.deleted_at.is_(None),
            Task.deleted_at.is_(None),
        )
    )

    if actor.role != UserRole.admin:
        stmt = stmt.join(
            ProjectMember,
            and_(
                ProjectMember.project_id == Project.id,
                ProjectMember.user_id == actor.id,
            ),
        )

    if project_id is not None:
        stmt = stmt.where(Project.id == project_id)
    if task_id is not None:
        stmt = stmt.where(Task.id == task_id)
    if kind is not None:
        stmt = stmt.where(Asset.kind == kind)
    if min_size is not None:
        stmt = stmt.where(Asset.size_bytes >= min_size)
    if max_size is not None:
        stmt = stmt.where(Asset.size_bytes <= max_size)
    if q:
        stmt = stmt.where(Asset.original_name.ilike(f"%{q}%"))

    if class_id is not None or status is not None:
        ann_stmt = (
            select(Annotation.id)
            .join(Frame, Frame.id == Annotation.frame_id)
            .where(Frame.asset_id == Asset.id)
        )
        if class_id is not None:
            ann_stmt = ann_stmt.where(Annotation.class_id == class_id)
        if status is not None:
            ann_stmt = ann_stmt.where(Annotation.status == status)
        stmt = stmt.where(ann_stmt.exists())

    if cursor is not None:
        decoded = _decode_cursor(cursor)
        if decoded is not None:
            last_ts, last_id = decoded
            stmt = stmt.where(
                or_(
                    Asset.created_at < last_ts,
                    and_(
                        Asset.created_at == last_ts,
                        Asset.id < last_id,
                    ),
                )
            )

    stmt = stmt.order_by(
        Asset.created_at.desc(), Asset.id.desc()
    ).limit(limit + 1)

    rows = list(db.execute(stmt).unique().all())

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last_asset = rows[-1][0]
        next_cursor = _encode_cursor(last_asset.created_at, last_asset.id)

    items: list[dict[str, Any]] = []
    for asset, project, task in rows:
        snippet: str | None = None
        if q:
            name_lower = asset.original_name.lower()
            needle = q.lower()
            idx = name_lower.find(needle)
            if idx >= 0:
                start = max(0, idx - 16)
                end = min(len(asset.original_name), idx + len(q) + 16)
                snippet = asset.original_name[start:end]
        items.append(
            {
                "asset_id": asset.id,
                "project_id": project.id,
                "project_name": project.name,
                "task_id": task.id,
                "task_name": task.name,
                "original_name": asset.original_name,
                "kind": asset.kind.value
                if isinstance(asset.kind, AssetKind)
                else str(asset.kind),
                "asset": asset,
                "match_snippet": snippet,
            }
        )

    return items, next_cursor
