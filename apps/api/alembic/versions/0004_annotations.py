"""annotations

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


annotation_kind = postgresql.ENUM("bbox", "polygon", "mask", "tag", name="annotation_kind")


def upgrade() -> None:
    annotation_kind.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "annotations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "task_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "frame_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("frames.id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column(
            "class_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("classes.id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column(
            "kind",
            postgresql.ENUM(name="annotation_kind", create_type=False),
            nullable=False,
        ),
        sa.Column("geometry", postgresql.JSONB, nullable=False),
        sa.Column("track_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_by", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_annotations_task_id", "annotations", ["task_id"])
    op.create_index("ix_annotations_frame_id", "annotations", ["frame_id"])
    op.create_index("ix_annotations_class_id", "annotations", ["class_id"])
    op.create_index("ix_annotations_track_id", "annotations", ["track_id"])


def downgrade() -> None:
    op.drop_index("ix_annotations_track_id", table_name="annotations")
    op.drop_index("ix_annotations_class_id", table_name="annotations")
    op.drop_index("ix_annotations_frame_id", table_name="annotations")
    op.drop_index("ix_annotations_task_id", table_name="annotations")
    op.drop_table("annotations")
    annotation_kind.drop(op.get_bind(), checkfirst=True)
