"""logo_ai_jobs.deferred -- realtime assets to take again at the end.

Revision ID: 0046
Revises: 0045
Create Date: 2026-10-06

A realtime request refused for a passing reason (Flex capacity short,
a 5xx, the network) while its neighbours got through was tried a few
more times and then marked failed, which with Flex lost about 4% of a
run's images. Such assets are now put at the end of the run and taken
again there.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "logo_ai_jobs",
        sa.Column(
            "deferred", postgresql.JSONB(), nullable=False, server_default="[]"
        ),
    )


def downgrade() -> None:
    op.drop_column("logo_ai_jobs", "deferred")
