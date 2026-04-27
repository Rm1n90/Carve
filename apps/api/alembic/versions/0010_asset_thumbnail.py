"""asset thumbnail key

Revision ID: 0010
Revises: 0009
Create Date: 2026-04-26
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "assets",
        sa.Column("thumbnail_minio_key", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("assets", "thumbnail_minio_key")
