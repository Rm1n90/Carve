"""weights workspace-scoped — project_id nullable + weight_project_defaults

Revision ID: 0018
Revises: 0017
Create Date: 2026-04-30

v3.5 Phase F5 — one weight, many projects.

The historical model tied each weight to exactly one project via
``weights.project_id NOT NULL``. That broke the user's mental model:
a weight is a model, models live in the workspace, and the user wants
to predict the same weight into different projects' tasks.

This migration:

  * Relaxes ``weights.project_id`` to nullable. ``NULL`` means the
    weight is workspace-wide (visible to every project); a non-NULL
    value scopes the weight to that project (legacy behavior).
  * Adds ``weight_project_defaults(project_id, task_kind) → weight_id``
    so a project can pin a workspace-wide weight as its default per
    task kind without flipping the weight's own ownership.
  * Backfills the new defaults table from rows where
    ``weights.is_default = true``.
  * Drops the now-redundant ``weights.is_default`` column and its
    partial unique index.

Down migration restores the historical shape — best-effort. If any
row was inserted with ``project_id = NULL`` after the upgrade, the
downgrade will fail at the ``SET NOT NULL`` step (PostgreSQL refuses
to change a column to NOT NULL when null rows exist). That is
intentional: workspace-wide weights are a new shape and forcing
them into a single project would lose information.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # NOTE: previous versions had a defensive ``if not has_table('weights'):
    # return`` escape clause here. That allowed alembic to silently stamp
    # this revision as applied on an empty DB whose ``alembic_version`` had
    # been hand-stamped past 0017, causing every subsequent
    # ``alembic upgrade head`` to no-op and the schema to stay empty.
    # If you reach this migration and ``weights`` does not exist, the DB is
    # corrupt — run ``alembic stamp base && alembic upgrade head`` to
    # rebuild from scratch.

    # 1. Create the new defaults table first so the backfill can write
    #    into it before we drop the source ``is_default`` column.
    op.create_table(
        "weight_project_defaults",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "task_kind",
            postgresql.ENUM(
                "detect",
                "segment",
                "classify",
                "pose",
                name="weight_task_kind",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "weight_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("weights.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "project_id", "task_kind", name="pk_weight_project_defaults"
        ),
    )

    # 2. Backfill from any existing is_default=true weights. Each row
    #    pins (project_id, task_kind) → weight_id. Use ON CONFLICT DO
    #    NOTHING so the migration is idempotent on dev DBs that may
    #    have multiple defaults due to pre-0015 history.
    op.execute(
        """
        INSERT INTO weight_project_defaults (project_id, task_kind, weight_id)
        SELECT project_id, task_kind, id
        FROM weights
        WHERE is_default = true AND project_id IS NOT NULL
        ON CONFLICT (project_id, task_kind) DO NOTHING
        """
    )

    # 3. Drop the partial unique index that enforced "one default per
    #    (project, task_kind)" — that constraint is now provided by the
    #    new table's primary key.
    op.execute("DROP INDEX IF EXISTS uq_weights_default_per_project_kind")

    # 4. Drop the is_default column AFTER the backfill so the data is
    #    safely captured in weight_project_defaults first.
    op.drop_column("weights", "is_default")

    # 5. Finally relax weights.project_id to nullable.
    op.alter_column(
        "weights",
        "project_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )


def downgrade() -> None:
    """Reverse the v3.5 F5 schema changes.

    NOTE: this fails if any ``weights`` row has ``project_id = NULL``
    (workspace-wide weights are a v3.5 concept). Manually reassign or
    delete those rows before running the downgrade.
    """
    # 1. Restore weights.project_id to NOT NULL.
    op.alter_column(
        "weights",
        "project_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )

    # 2. Re-add is_default with the same default + non-null shape.
    op.add_column(
        "weights",
        sa.Column(
            "is_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # 3. Repopulate is_default from weight_project_defaults.
    op.execute(
        """
        UPDATE weights w
        SET is_default = true
        FROM weight_project_defaults d
        WHERE w.id = d.weight_id
        """
    )

    # 4. Recreate the partial unique index.
    op.create_index(
        "uq_weights_default_per_project_kind",
        "weights",
        ["project_id", "task_kind"],
        unique=True,
        postgresql_where=sa.text("is_default = true"),
    )

    # 5. Drop the new table.
    op.drop_table("weight_project_defaults")
