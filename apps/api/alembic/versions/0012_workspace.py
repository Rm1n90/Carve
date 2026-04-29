"""workspace singleton table

Revision ID: 0012
Revises: 0011
Create Date: 2026-04-29

Bug 6 (v3.1 audit): the Settings → Workspace surface used to be a
"Coming soon" placeholder backed by environment variables. We promote the
workspace to a real, editable, **singleton** Postgres row so admins can
rename the workspace and add a description without rebuilding the API.

Singleton invariant: exactly one row in ``workspace`` for a given install.
The migration seeds that row with the historical default name "Carve" so
the first GET after migration always finds it.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workspace",
        sa.Column(
            "id",
            pg.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "name",
            sa.String(length=120),
            nullable=False,
            server_default=sa.text("'Carve'"),
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    # Seed the singleton row so the API never has to handle a missing-row
    # case at runtime — the invariant is "exactly one workspace row exists".
    op.execute("INSERT INTO workspace (name) VALUES ('Carve')")


def downgrade() -> None:
    op.drop_table("workspace")
