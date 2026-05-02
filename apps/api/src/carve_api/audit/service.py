"""Best-effort audit recorder (Plan-13 Phase 7 Task 3).

``record(...)`` is wired into review / retrain / export / task code
paths. It MUST NEVER raise into the caller -- audit writes are
secondary to the user's actual action. Failures are logged and the
function returns ``None`` so the calling business logic can proceed.

The ``flush()`` call is intentional: it surfaces FK/type errors here
(still inside the calling transaction) so we can log them, instead of
deferring the failure to the caller's eventual ``commit()``. We do NOT
``rollback()`` on failure -- that would also discard the caller's
pending business-logic mutations. The audit row simply will not commit
if its insert raises before commit.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.orm import Session

from carve_api.audit.models import AuditEvent

log = logging.getLogger(__name__)


def record(
    db: Session,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | None,
    project_id: uuid.UUID | None,
    summary: str,
    metadata: dict[str, Any] | None = None,
) -> AuditEvent | None:
    """Append one row to ``audit_events``. Best-effort.

    Returns the created row on success, ``None`` on failure. Never
    raises -- audit writes must not crash the user's request.
    """
    try:
        ev = AuditEvent(
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
            summary=summary,
            metadata_=metadata,
        )
        db.add(ev)
        db.flush()
        return ev
    except Exception as exc:  # noqa: BLE001 -- swallow audit-only failures
        log.warning("audit.record failed action=%s: %r", action, exc)
        return None
