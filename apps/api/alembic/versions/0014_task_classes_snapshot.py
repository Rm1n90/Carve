"""snapshot project class ids onto existing tasks

Revision ID: 0014
Revises: 0013
Create Date: 2026-04-29

v3.2 Issue 3 — until now ``tasks.allowed_class_ids`` defaulted to ``NULL``
and the effective-classes resolver interpreted ``NULL`` as "all current
project classes". The side-effect was that adding a class to a project
made it appear in every existing task whose subset was ``NULL`` —
something users explicitly do *not* want.

This migration locks each existing task to a snapshot of its parent
project's *current* class id list (ordered by ``classes.idx``). Combined
with the matching service change in ``TaskService.create`` (which now
snapshots at creation time), new project classes added after the fact
will no longer leak into already-created tasks.

Tasks belonging to projects with zero classes will be assigned an empty
array (``{}``), not ``NULL``, so the legacy "NULL means all" semantic is
not reintroduced for them.

The downgrade clears ``allowed_class_ids`` back to ``NULL`` for *all*
tasks. This is lossy — any user-curated subset created after this
migration ran is destroyed by a downgrade. It is safe only as a one-off
revert immediately after the upgrade.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE tasks t
        SET allowed_class_ids = COALESCE(
            (
                SELECT array_agg(c.id ORDER BY c.idx)
                FROM classes c
                WHERE c.project_id = t.project_id
            ),
            ARRAY[]::uuid[]
        )
        WHERE t.allowed_class_ids IS NULL
        """
    )


def downgrade() -> None:
    # Lossy: clears every task's subset back to NULL. Any user-curated
    # subset created after the upgrade is destroyed.
    op.execute("UPDATE tasks SET allowed_class_ids = NULL")
