"""classes.text_prompt -- per-class SAM 3 text concept

Revision ID: 0020
Revises: 0019
Create Date: 2026-05-01

v3.8 Phase 3 -- adds a nullable ``text_prompt`` column to ``classes``.
The editor's Text-SAM mode runs SAM 3 text-prompt with this string per
class so users define stable prompts once (e.g. class "person" ->
"a person standing or walking") instead of typing free text per asset.

Empty / NULL means the class is not eligible for Text-SAM. The runner
UI hides such classes from the picklist.

Down migration drops the column.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op


revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "classes",
        sa.Column("text_prompt", sa.String(length=200), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("classes", "text_prompt")
