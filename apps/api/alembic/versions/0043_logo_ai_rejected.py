"""logo_ai_jobs.rejected_boxes -- what the second pass threw out.

Revision ID: 0043
Revises: 0042
Create Date: 2026-10-02

A run with the double-check on looks at every detected box a second
time and drops the ones that are not logos. How many it dropped was not
kept anywhere, so a run could not say what the second pass had done for
its cost.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0043"
down_revision: str | None = "0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A constant default: metadata-only on PostgreSQL 11+, no rewrite.
    op.add_column(
        "logo_ai_jobs",
        sa.Column("rejected_boxes", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("logo_ai_jobs", "rejected_boxes")
