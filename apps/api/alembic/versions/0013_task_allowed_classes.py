"""task allowed_class_ids subset column

Revision ID: 0013
Revises: 0012
Create Date: 2026-04-29

v3.1 Issue 3 (Option A: subset model) — each task may use a *subset* of
its parent project's classes. The subset is stored as a UUID array on the
task row. ``NULL`` means "no override; use all project classes" so the
feature is opt-in and existing rows keep working without backfill. An
empty array (``[]``) is a legal but unusual state meaning "no classes are
allowed for this task".

Annotations referencing classes that are later excluded from the task's
``allowed_class_ids`` are NOT cascade-deleted — the API just narrows the
list returned to the editor. The DB rows remain so we never destroy data
on a benign UI tweak.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "allowed_class_ids",
            pg.ARRAY(pg.UUID(as_uuid=True)),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("tasks", "allowed_class_ids")
