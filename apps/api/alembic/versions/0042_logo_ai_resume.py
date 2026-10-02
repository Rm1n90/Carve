"""logo_ai_jobs: notice, resume_after, pauses, stalls -- runs that wait and resume.

Revision ID: 0042
Revises: 0041
Create Date: 2026-09-30

A run used to end, or hang, when something outside it went away: the
provider or the network down while submitting, the worker killed more
often than RQ retries. Now a run that cannot go on says what it is
waiting for and when it will try again, and a supervisor in the API
restarts any run that should be working and is not.

* ``notice`` / ``resume_after`` -- what the run waits for, and until when.
* ``pauses`` -- waits in a row, which sets how long the next one is.
* ``stalls`` -- restarts in a row after the run stopped without a word;
  past a limit the run is closed out instead of restarted for ever.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("logo_ai_jobs", sa.Column("notice", sa.Text(), nullable=True))
    op.add_column(
        "logo_ai_jobs", sa.Column("resume_after", sa.DateTime(timezone=True), nullable=True)
    )
    # A constant default: metadata-only on PostgreSQL 11+, no rewrite.
    op.add_column(
        "logo_ai_jobs",
        sa.Column("pauses", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "logo_ai_jobs",
        sa.Column("stalls", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("logo_ai_jobs", "stalls")
    op.drop_column("logo_ai_jobs", "pauses")
    op.drop_column("logo_ai_jobs", "resume_after")
    op.drop_column("logo_ai_jobs", "notice")
