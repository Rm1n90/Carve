"""logo_ai_task_prompts -- a task's own Logo AI instructions.

Revision ID: 0044
Revises: 0043
Create Date: 2026-10-02

What counts as a logo is not the same in every task. Until now the
instructions the model gets were one text in the code; this lets a task
carry its own, for detection and for the second pass, with NULL meaning
the default.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "logo_ai_task_prompts",
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("instructions", sa.Text(), nullable=True),
        sa.Column("check_instructions", sa.Text(), nullable=True),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("logo_ai_task_prompts")
