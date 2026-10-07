"""logo_ai_credit -- a provider's credit balance, as entered by an admin.

Revision ID: 0045
Revises: 0044
Create Date: 2026-10-02

No provider tells an API client what is left of a prepaid balance. An
admin copies it from the provider's billing page; every cost booked
after that is added to ``spent_usd``, so what is left can be shown
before a run is started.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "logo_ai_credit",
        sa.Column("provider", sa.String(24), primary_key=True),
        sa.Column("amount_usd", sa.Float(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("spent_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("reported_day_usd", sa.Float(), nullable=True),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("logo_ai_credit")
