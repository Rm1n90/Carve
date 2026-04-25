"""assets and frames

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


asset_kind = postgresql.ENUM("image", "video", name="asset_kind")


def upgrade() -> None:
    asset_kind.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "assets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            postgresql.ENUM(name="asset_kind", create_type=False),
            nullable=False,
        ),
        sa.Column("xxh3_128", sa.String(32), nullable=False),
        sa.Column("mime", sa.String(80), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("width", sa.Integer, nullable=True),
        sa.Column("height", sa.Integer, nullable=True),
        sa.Column("frames", sa.Integer, nullable=False, server_default="1"),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("task_id", "xxh3_128", name="uq_assets_task_hash"),
    )
    op.create_index("ix_assets_task_id", "assets", ["task_id"])
    op.create_index("ix_assets_xxh3_128", "assets", ["xxh3_128"])

    op.create_table(
        "frames",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idx", sa.Integer, nullable=False),
        sa.Column("pts_ms", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("asset_id", "idx", name="uq_frames_asset_idx"),
    )
    op.create_index("ix_frames_asset_id", "frames", ["asset_id"])


def downgrade() -> None:
    op.drop_index("ix_frames_asset_id", table_name="frames")
    op.drop_table("frames")
    op.drop_index("ix_assets_xxh3_128", table_name="assets")
    op.drop_index("ix_assets_task_id", table_name="assets")
    op.drop_table("assets")
    asset_kind.drop(op.get_bind(), checkfirst=True)
