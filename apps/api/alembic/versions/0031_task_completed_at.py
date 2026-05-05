"""tasks: completed_at + completed_by columns.

Revision ID: 0031
Revises: 0030
Create Date: 2026-05-05

Plan-21 -- adds task-completion tracking. Distinct from ``archived_at``
(an "I'm putting this aside" marker); ``completed_at`` is "all assets in
this task have been annotated and the user has signed it off". Both
columns are nullable; toggling completion sets/clears them in tandem.

* ``completed_at`` -- timestamp the task was marked complete. NULL means
  the task is still in progress.
* ``completed_by`` -- user who flipped the switch. ``ON DELETE SET NULL``
  preserves history when the user row goes away.

A composite index on ``(project_id, completed_at)`` keeps future
"completed-only" / "active-only" filtered queries cheap.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "completed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_tasks_project_completed_at",
        "tasks",
        ["project_id", "completed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_project_completed_at", table_name="tasks")
    op.drop_column("tasks", "completed_by")
    op.drop_column("tasks", "completed_at")
