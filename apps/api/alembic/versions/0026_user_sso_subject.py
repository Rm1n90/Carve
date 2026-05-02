"""user_sso_subject -- add SSO subject column to users.

Revision ID: 0026
Revises: 0025
Create Date: 2026-05-01

Plan-13 Phase 7 Task 5 -- adds a nullable ``sso_subject`` column to
``users`` so OIDC-linked accounts can be looked up by their provider's
stable subject identifier without colliding with locally registered
users that have no SSO link.

A partial unique index enforces uniqueness only when the value is
present, so existing local-only users (``sso_subject IS NULL``) do not
collide with each other.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op


revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("sso_subject", sa.Text(), nullable=True),
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_users_sso_subject ON users (sso_subject) "
        "WHERE sso_subject IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_sso_subject")
    op.drop_column("users", "sso_subject")
