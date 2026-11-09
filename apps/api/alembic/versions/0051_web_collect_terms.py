"""Collect from web: a keyword's other search words (Chinese for Baidu and 360).

Revision ID: 0051
Revises: 0050
Create Date: 2026-11-09

See carve_api.web_collect.translate.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0051"
down_revision: str | None = "0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "web_collect_keywords",
        sa.Column("terms", JSONB, nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("web_collect_keywords", "terms")
