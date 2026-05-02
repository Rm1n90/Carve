"""Audit log read endpoint (Plan-13 Phase 7 Task 3).

Single endpoint:

  * ``GET /projects/{project_id}/audit`` -- paginated, project-scoped.

ACL: any project member (owner / admin / member / viewer) may read the
audit log -- audit visibility is intentionally broader than mutation
rights, since the log is a transparency feature. Non-members get the
membership-aware ``404 ProjectNotFound`` / ``403 NotProjectMember``
codes from :func:`require_project_role`.

Pagination uses an opaque cursor encoding the last seen ``(occurred_at,
id)`` pair (base64-urlsafe). The compound key is required to break ties
when two rows share an ``occurred_at`` -- otherwise a tie-bound row
could be skipped or duplicated across pages.
"""

from __future__ import annotations

import base64
import binascii
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from carve_api.audit.models import AuditEvent
from carve_api.audit.schemas import AuditEventOut, AuditPage
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.service import _READ_ROLES, require_project_role


router = APIRouter(tags=["audit"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _encode_cursor(occurred_at: datetime, row_id: uuid.UUID) -> str:
    raw = f"{occurred_at.isoformat()}|{row_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID] | None:
    """Decode an opaque cursor into ``(occurred_at, id)``.

    Returns ``None`` for any malformed cursor so the caller can 422 it
    centrally instead of branching on every parse failure.
    """
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


@router.get(
    "/projects/{project_id}/audit",
    response_model=AuditPage,
)
def list_project_audit(
    project_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    action: str | None = None,
    actor: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AuditPage:
    try:
        # Plan-13 Phase 7 Task 3 -- audit is readable by ANY project member.
        require_project_role(db, user, project_id, _READ_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    stmt = select(AuditEvent).where(AuditEvent.project_id == project_id)
    if action is not None:
        stmt = stmt.where(AuditEvent.action == action)
    if actor is not None:
        stmt = stmt.where(AuditEvent.actor_id == actor)

    if cursor is not None:
        decoded = _decode_cursor(cursor)
        if decoded is None:
            raise HTTPException(status_code=422, detail="invalid_cursor")
        last_ts, last_id = decoded
        # Strict tie-break: prefer rows with strictly smaller occurred_at,
        # OR equal occurred_at with smaller id (UUIDs sort as bytes).
        stmt = stmt.where(
            or_(
                AuditEvent.occurred_at < last_ts,
                and_(
                    AuditEvent.occurred_at == last_ts,
                    AuditEvent.id < last_id,
                ),
            )
        )

    stmt = stmt.order_by(
        AuditEvent.occurred_at.desc(), AuditEvent.id.desc()
    ).limit(limit + 1)
    rows = list(db.execute(stmt).scalars())

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = _encode_cursor(last.occurred_at, last.id)

    return AuditPage(
        items=[AuditEventOut.from_orm_event(r) for r in rows],
        next_cursor=next_cursor,
    )
