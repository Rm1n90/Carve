"""weight_assignments — many-to-many weight <-> project membership

Revision ID: 0019
Revises: 0018
Create Date: 2026-04-30

v3.7 Phase 3 Issue 4 — explicit many-to-many between weights and
projects. The 0018 migration relaxed ``weights.project_id`` so a single
weight could be workspace-wide (``NULL``) and visible to every project,
plus added ``weight_project_defaults`` for per-(project, task_kind)
defaults. Neither covered the "this weight is assigned to project A and
project C, but not B" use case.

This migration adds a join table ``weight_assignments(weight_id,
project_id)`` so the user can explicitly pin a weight to a curated set
of projects and add/remove them later. The existing project listing in
``WeightService.list_for_project`` is extended (in code, not schema) to
include weights joined via this table on top of the workspace-wide and
legacy-scoped paths.

Down migration drops the table + index. No data is migrated either way
(legacy scoping still works through ``weights.project_id``).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "weight_assignments",
        sa.Column(
            "weight_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("weights.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint(
            "weight_id", "project_id", name="pk_weight_assignments"
        ),
    )
    op.create_index(
        "ix_weight_assignments_project_id",
        "weight_assignments",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_weight_assignments_project_id", table_name="weight_assignments"
    )
    op.drop_table("weight_assignments")
