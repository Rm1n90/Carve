"""assets: drop per-task content-hash uniqueness

Revision ID: 0037
Revises: 0036
Create Date: 2026-06-17

Asset dedup moved from CONTENT (task_id, xxh3_128) to FILENAME, enforced in
``AssetService.upload_stream`` as a per-task (task_id, original_name) check.
Identical bytes uploaded under different filenames are now intentionally
allowed (multiple assets may share one content-addressed ``assets/<hash>/``
blob; ``AssetService.delete`` ref-counts the hash before removing the blob).

The old ``UniqueConstraint("task_id", "xxh3_128")`` must therefore be dropped.
``xxh3_128`` keeps its plain index (``ix_assets_xxh3_128`` from the column's
``index=True``) — it is still the storage key and is used by the delete
ref-count query.

Downgrade re-adds the unique constraint; it will fail if duplicate
(task_id, xxh3_128) rows have been created in the meantime (expected, since
this migration exists precisely to allow them).
"""
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_constraint("uq_assets_task_hash", "assets", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint(
        "uq_assets_task_hash", "assets", ["task_id", "xxh3_128"]
    )
