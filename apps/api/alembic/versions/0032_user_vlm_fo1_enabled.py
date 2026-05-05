"""users: per-user VLM-FO1 toggle.

Revision ID: 0032
Revises: 0031
Create Date: 2026-05-05

Adds a Boolean ``vlm_fo1_enabled`` column to the ``users`` table.

Default ``False`` matches the spec's "feature OFF by default" posture.
The column is non-nullable with a server-side default so existing rows
backfill automatically and writers never have to think about NULL.

When ``False``, the editor's annotation surfaces (single-image
text-prompt + Auto mode dialog) skip the VLM-FO1 precision filter and
behave byte-for-byte identical to today. When ``True`` (and the
server reports ``vlm_fo1_available=true`` via /models/sam-status),
the editor opts every relevant request into the filter.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op


revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "vlm_fo1_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "vlm_fo1_enabled")
