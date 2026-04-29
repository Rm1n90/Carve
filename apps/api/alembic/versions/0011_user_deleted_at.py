"""user soft delete (deleted_at)

Revision ID: 0011
Revises: 0010
Create Date: 2026-04-29

Adds ``users.deleted_at`` so admins can soft-delete members from the new
Settings -> Members CRUD UI (audit Bug 14). The partial index on rows where
``deleted_at IS NULL`` keeps the active-member list lookups O(active users)
and skips graveyard rows automatically.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_users_deleted_at",
        "users",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_column("users", "deleted_at")
