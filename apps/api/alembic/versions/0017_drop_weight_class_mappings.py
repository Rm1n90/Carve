"""drop weight_class_mappings — replaced by predict-time overrides

Revision ID: 0017
Revises: 0016
Create Date: 2026-04-30

v3.5 Phase F4 — the persistent ``weight_class_mappings`` table is gone.
Mapping is intrinsically per-task, not per-weight (one weight can be
predicted into many tasks, each with its own ``allowed_class_ids``), so
we replaced it with:

  - ``GET /weights/{wid}/mapping-suggestions?task_id=…`` (read-only
    helper) for auto-name-match
  - ``class_overrides`` on the ``POST /assets/{aid}/auto-annotate`` body
    for the user's per-call picks

Stored mapping data is NOT recoverable on downgrade. The frontend
predict popover persists the user's last picks per ``(weight, task)``
in ``localStorage``, which is the only place those overrides now live.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Use IF EXISTS so the migration is idempotent on environments where
    # 0016 ran but the table was hand-dropped, or where alembic_version
    # was stamped past 0016 against a partial schema.
    op.execute("DROP INDEX IF EXISTS ix_weight_class_mappings_weight_id")
    op.execute("DROP TABLE IF EXISTS weight_class_mappings")


def downgrade() -> None:
    """Recreate an empty ``weight_class_mappings`` table.

    NOTE: the original mapping rows are not recoverable on downgrade —
    they were dropped in :func:`upgrade` and only the user's last
    per-(weight, task) picks survive in the frontend localStorage.
    """
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
