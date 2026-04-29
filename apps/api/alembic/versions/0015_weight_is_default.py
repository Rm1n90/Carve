"""weight is_default flag + partial unique per (project, task_kind)

Revision ID: 0015
Revises: 0014
Create Date: 2026-04-29

v3.3 Issue 4 — projects can now mark exactly one weight per
``(project_id, task_kind)`` as the default. The auto-annotate endpoint
falls back to this default when no explicit ``weight_id`` is supplied,
and the editor's predict popover pre-selects it on open. The partial
unique index enforces the "at most one default per kind per project"
invariant at the database level so no two requests can race past the
service-side toggle.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "weights",
        sa.Column(
            "is_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "uq_weights_default_per_project_kind",
        "weights",
        ["project_id", "task_kind"],
        unique=True,
        postgresql_where=sa.text("is_default = true"),
    )


def downgrade() -> None:
    op.drop_index("uq_weights_default_per_project_kind", table_name="weights")
    op.drop_column("weights", "is_default")
