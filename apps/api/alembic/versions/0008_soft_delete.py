"""soft delete on projects and tasks

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-26
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tasks",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_projects_deleted_at", "projects", ["deleted_at"]
    )
    op.create_index(
        "ix_tasks_deleted_at", "tasks", ["deleted_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_deleted_at", table_name="tasks")
    op.drop_index("ix_projects_deleted_at", table_name="projects")
    op.drop_column("tasks", "deleted_at")
    op.drop_column("projects", "deleted_at")
