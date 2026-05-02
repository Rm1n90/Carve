"""tasks: due_date + archived_at columns.

Revision ID: 0029
Revises: 0028
Create Date: 2026-05-02

Plan-15 Phase 9 Track G -- adds optional scheduling and archive support
to ``tasks``:

* ``due_date`` -- optional timestamp for "this task is expected to be
  done by X". Frontend exposes a date picker on the create form.
* ``archived_at`` -- optional soft-archive marker. The Archived tab in
  the tasks toolbar already exists; this column is what the new
  Archive action sets and the filter reads.

Both columns are nullable with no backfill so existing rows are
unaffected.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op


revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("due_date", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tasks",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_tasks_archived_at", "tasks", ["archived_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_archived_at", table_name="tasks")
    op.drop_column("tasks", "archived_at")
    op.drop_column("tasks", "due_date")
