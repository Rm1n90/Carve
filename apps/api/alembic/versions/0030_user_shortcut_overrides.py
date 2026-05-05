"""users: per-user keyboard shortcut overrides.

Revision ID: 0030
Revises: 0029
Create Date: 2026-05-05

Adds a sparse JSONB ``shortcut_overrides`` column to the ``users``
table. The column stores only the actions a user has actively
overridden -- missing keys mean "use the default chord". An empty
object (the column's default) means "all defaults". Empty-string
values are reserved for "unbound" -- the handler stays registered
but never fires.

The shape is::

    { "<action_id>": "<chord>" }

where ``action_id`` matches ``^[a-z][a-z0-9_]{0,63}$`` and ``chord``
is the normalised internal chord format (lowercase, modifiers sorted
alphabetically, joined with ``+``; e.g. ``"mod+shift+z"``).

The column is non-nullable with a server-side default of ``{}``::jsonb
so existing rows backfill automatically and writers never have to
think about NULL vs empty.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "shortcut_overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "shortcut_overrides")
