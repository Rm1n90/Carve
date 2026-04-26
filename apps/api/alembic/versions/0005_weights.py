"""weights

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


weight_task_kind = postgresql.ENUM(
    "detect", "segment", "classify", "pose", name="weight_task_kind"
)


def upgrade() -> None:
    weight_task_kind.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "weights",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column(
            "task_kind",
            postgresql.ENUM(name="weight_task_kind", create_type=False),
            nullable=False,
        ),
        sa.Column("minio_key", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("class_names", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_weights_project_id", "weights", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_weights_project_id", table_name="weights")
    op.drop_table("weights")
    weight_task_kind.drop(op.get_bind(), checkfirst=True)
