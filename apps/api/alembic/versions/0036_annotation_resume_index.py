"""annotations: partial index for per-user resume query

Revision ID: 0036
Revises: 0035
Create Date: 2026-05-26

Creates a partial index on (task_id, created_by, updated_at DESC) to support
the per-user task resume query:

    SELECT frame_id, updated_at FROM annotations
    WHERE task_id = ? AND created_by = ? AND frame_id IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1

The partial index `WHERE frame_id IS NOT NULL` keeps it small, excluding
tag-kind annotations which have NULL frame_id.
"""
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # CONCURRENTLY avoids write-locking the annotations table during
    # the index build on production-sized data. Must run outside a
    # transaction, hence the autocommit_block.
    with op.get_context().autocommit_block():
        op.create_index(
            "ix_annotations_task_user_updated",
            "annotations",
            ["task_id", "created_by", "updated_at"],
            postgresql_where="frame_id IS NOT NULL",
            postgresql_ops={"updated_at": "DESC"},
            postgresql_concurrently=True,
            if_not_exists=True,
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(
            "ix_annotations_task_user_updated",
            table_name="annotations",
            postgresql_concurrently=True,
            if_exists=True,
        )
