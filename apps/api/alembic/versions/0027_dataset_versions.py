"""dataset_versions -- versioned snapshots of task datasets.

Revision ID: 0027
Revises: 0026
Create Date: 2026-05-02

Plan-13 Phase 7 Task 6 -- introduces a ``dataset_versions`` table that
records immutable snapshots of a task's dataset bundle every time a
retrain / export job completes (or a manual / rollback snapshot is
taken). Rows reference the underlying YOLO/COCO bundle stored in MinIO
via ``blob_key`` so the differ can re-parse the bundle on demand.

Indexes target the two read patterns:
  * ``(project_id, created_at desc)`` -- per-project timeline.
  * ``(task_id,    created_at desc)`` -- per-task timeline (the dataset
    panel inside a task).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dataset_versions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=True),
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
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "frozen",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("summary", postgresql.JSONB(), nullable=True),
        sa.Column("blob_key", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "kind IN ('retrain','export','manual','rollback_pre','rollback_post')",
            name="ck_dataset_versions_kind",
        ),
    )
    op.create_index(
        "ix_dataset_versions_project_created_at",
        "dataset_versions",
        ["project_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_dataset_versions_task_created_at",
        "dataset_versions",
        ["task_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dataset_versions_task_created_at", table_name="dataset_versions"
    )
    op.drop_index(
        "ix_dataset_versions_project_created_at", table_name="dataset_versions"
    )
    op.drop_table("dataset_versions")
