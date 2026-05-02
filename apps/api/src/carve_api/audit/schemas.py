# Armin Mehri — mehri.armin@gmail.com
"""Pydantic response schemas for the audit log endpoint."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AuditEventOut(BaseModel):
    """One row of the audit log, as returned over HTTP."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    occurred_at: datetime
    actor_id: uuid.UUID | None = None
    action: str
    target_type: str
    target_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    summary: str
    metadata: dict[str, Any] | None = Field(default=None)

    @classmethod
    def from_orm_event(cls, ev: Any) -> "AuditEventOut":
        return cls(
            id=ev.id,
            occurred_at=ev.occurred_at,
            actor_id=ev.actor_id,
            action=ev.action,
            target_type=ev.target_type,
            target_id=ev.target_id,
            project_id=ev.project_id,
            summary=ev.summary,
            metadata=ev.metadata_,
        )


class AuditPage(BaseModel):
    items: list[AuditEventOut]
    next_cursor: str | None = None
