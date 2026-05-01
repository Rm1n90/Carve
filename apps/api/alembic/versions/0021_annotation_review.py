"""annotations.review -- status / reviewed_by_id / reviewed_at / prev_geometry

Revision ID: 0021
Revises: 0020
Create Date: 2026-05-01

v3.x Phase 5 (plan-09 task-01) -- adds the review-workflow columns to
``annotations``:

* ``status``         -- "proposed" | "accepted" | "rejected" (NOT NULL,
                        server_default 'proposed' so existing rows backfill
                        cleanly).
* ``reviewed_by_id`` -- FK to ``users.id`` (SET NULL on user delete),
                        nullable.
* ``reviewed_at``    -- timezone-aware timestamp, nullable.
* ``prev_geometry``  -- JSONB snapshot of the geometry seen by the last
                        reviewer, nullable. Used to detect post-review
                        edits and revert status to 'proposed'.

Adds a composite index on ``(task_id, status)`` for the review-queue
query path. The pre-existing ``ix_annotations_task_id`` is preserved.

Down migration drops the index and the four columns.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "annotations",
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="proposed",
        ),
    )
    op.add_column(
        "annotations",
        sa.Column("reviewed_by_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_annotations_reviewed_by_id_users",
        "annotations",
        "users",
        ["reviewed_by_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "annotations",
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "annotations",
        sa.Column("prev_geometry", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_index(
        "ix_annotations_task_id_status",
        "annotations",
        ["task_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_annotations_task_id_status", table_name="annotations")
    op.drop_constraint(
        "fk_annotations_reviewed_by_id_users", "annotations", type_="foreignkey"
    )
    op.drop_column("annotations", "prev_geometry")
    op.drop_column("annotations", "reviewed_at")
    op.drop_column("annotations", "reviewed_by_id")
    op.drop_column("annotations", "status")
