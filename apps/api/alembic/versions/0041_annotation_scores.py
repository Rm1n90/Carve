"""annotations.confidence + annotations.visible -- model scores on a box.

Revision ID: 0041
Revises: 0040
Create Date: 2026-09-30

Logo AI gets two numbers from the model for every box: how confident it
is, and what percentage of the logo is in view. Until now they were
compared against the run's thresholds and thrown away, so trying a
different threshold meant paying for the image again.

Keeping them on the annotation lets a run be made once with loose
thresholds and then filtered in the editor for free.

Both are NULL for anything a person drew, and are cleared when a person
changes a scored box's geometry or class: from then on it is that
person's box, and a score filter must not remove it.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable with no default: a metadata-only change, no table rewrite.
    op.add_column("annotations", sa.Column("confidence", sa.Float(), nullable=True))
    op.add_column("annotations", sa.Column("visible", sa.SmallInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("annotations", "visible")
    op.drop_column("annotations", "confidence")
