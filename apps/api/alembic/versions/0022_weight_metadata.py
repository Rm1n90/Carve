"""weights.metadata -- nullable JSONB column for retrain metrics + audit.

Revision ID: 0022
Revises: 0021
Create Date: 2026-05-01

Plan-09b Task 5 -- adds a nullable ``metadata`` JSONB column to the
``weights`` table so the retrain pipeline can persist the trainer's
metrics dict alongside hyperparameters (epochs, imgsz, include_proposed)
and a ``trained_at`` timestamp. Today the metrics are only logged.

The column is nullable + has no server default; rows registered through
the upload path keep ``metadata = NULL``.

Down migration drops the column.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "weights",
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("weights", "metadata")
