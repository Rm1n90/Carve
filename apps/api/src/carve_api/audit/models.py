"""ORM mapping for the ``audit_events`` table (Plan-13 Phase 7 Task 3).

The Postgres column is named ``metadata`` (per spec) but the ORM
attribute is ``metadata_`` because ``Base.metadata`` is reserved by
SQLAlchemy for the table-collection registry. The ``mapped_column``
first positional argument names the underlying DB column so queries see
``metadata`` while the Python attribute stays collision-free.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True
    )

    __table_args__ = (
        Index(
            "ix_audit_events_project_occurred_at",
            "project_id",
            "occurred_at",
        ),
        Index(
            "ix_audit_events_actor_occurred_at",
            "actor_id",
            "occurred_at",
        ),
        Index(
            "ix_audit_events_action_occurred_at",
            "action",
            "occurred_at",
        ),
    )
