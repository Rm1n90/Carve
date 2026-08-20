"""tasks: per-task GPU/model access grant for non-admin members

Revision ID: 0038
Revises: 0037
Create Date: 2026-08-20

Outsourcing hardening. GPU-backed features (My Model predict,
Auto-Annotate, Smart Find / YOLOE, interactive SAM, SAM tracking) are
admin-only by default so an outsourced annotator can neither resell nor
benefit from the workspace's GPU. A workspace admin can hand a *single*
task back to its members by flipping this column from the task's
settings menu.

Default ``false`` — every pre-existing task starts locked down, which is
the safe direction for a security control.
"""
import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "gpu_access_for_members",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("tasks", "gpu_access_for_members")
