"""ORM mapping for the ``dataset_versions`` table (Plan-13 Phase 7 Task 6).

The Postgres column is named ``summary`` but the ORM attribute is
``metadata_summary`` to avoid colliding with ``Base.metadata`` (which
SQLAlchemy reserves for the table-collection registry). The
``mapped_column`` first positional argument names the underlying DB
column so SQL still sees ``summary``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


# Allowed values for the ``kind`` column (mirrors the CHECK constraint
# on the table).
DATASET_KINDS: tuple[str, ...] = (
    "retrain",
    "export",
    "manual",
    "rollback_pre",
    "rollback_post",
)


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    frozen: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Column is named ``summary`` in SQL; Python attribute renamed to
    # avoid the ``Base.metadata`` clash. See module docstring.
    metadata_summary: Mapped[dict | None] = mapped_column(
        "summary", JSONB, nullable=True
    )
    blob_key: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('retrain','export','manual','rollback_pre','rollback_post')",
            name="ck_dataset_versions_kind",
        ),
        Index(
            "ix_dataset_versions_project_created_at",
            "project_id",
            "created_at",
        ),
        Index(
            "ix_dataset_versions_task_created_at",
            "task_id",
            "created_at",
        ),
    )
