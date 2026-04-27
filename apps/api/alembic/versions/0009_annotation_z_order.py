"""annotation z_order

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-26
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "annotations",
        sa.Column(
            "z_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.create_index(
        "ix_annotations_z_order",
        "annotations",
        ["z_order"],
    )


def downgrade() -> None:
    op.drop_index("ix_annotations_z_order", table_name="annotations")
    op.drop_column("annotations", "z_order")
