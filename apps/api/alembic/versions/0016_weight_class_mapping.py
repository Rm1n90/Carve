"""weight_class_mappings — explicit mapping between YOLO weight classes and project classes

Revision ID: 0016
Revises: 0015
Create Date: 2026-04-29

v3.3 Issue 3c — historically, ``inference.autoannotate`` matched detections
to project classes purely by case-insensitive name and *silently dropped*
anything that didn't match. The weight's stored ``class_names`` JSONB was
dead data on the predict path, and COCO indices vs. project ``class.idx``
were never compared.

This migration introduces an explicit mapping table:

  - One row per ``(weight_id, weight_class_idx)`` (also one per name).
  - ``project_class_id`` is nullable so unmapped weight classes can be
    represented and surfaced in the UI for manual binding.
  - Auto-populated on weight upload via name match; the user can override
    each row from the weight detail panel.

The autoannotate pipeline now consults this table first, falls back to
name-match for legacy rows that predate the mapping, and surfaces a
"created N / skipped M (unmapped: …)" summary on the response.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "weight_class_mappings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "weight_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("weights.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("weight_class_idx", sa.Integer(), nullable=False),
        sa.Column("weight_class_name", sa.String(length=255), nullable=False),
        sa.Column(
            "project_class_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("classes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "weight_id", "weight_class_idx", name="uq_weight_class_mappings_weight_idx"
        ),
    )
    op.create_index(
        "ix_weight_class_mappings_weight_id",
        "weight_class_mappings",
        ["weight_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_weight_class_mappings_weight_id", table_name="weight_class_mappings"
    )
    op.drop_table("weight_class_mappings")
