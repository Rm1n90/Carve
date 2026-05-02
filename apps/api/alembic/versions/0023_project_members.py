"""project_members -- per-project membership table.

Revision ID: 0023
Revises: 0022
Create Date: 2026-05-01

Plan-13 Phase 7 Task 1 -- introduces a ``project_members`` table that
records per-project access alongside a role (``owner | admin | member |
viewer``). Composite primary key ``(project_id, user_id)``. A secondary
index on ``user_id`` answers "what projects am I a member of?".

The CHECK constraint on ``role`` is a plain text constraint (no PG enum)
so that future migrations can add new roles without an ALTER TYPE dance.

Backfill (idempotent via ``ON CONFLICT DO NOTHING``):

1. Every existing project gets one ``owner`` row pointing at
   ``projects.owner_id`` -- the de-facto creator column on the projects
   table (the spec calls it ``created_by`` but the actual column is
   ``owner_id``; same semantics).
2. For projects with a NULL ``owner_id`` (defensive: NOT NULL today, but
   we keep the query forward-compatible) we look up the oldest
   ``users.role = 'admin'`` and use that as the owner. If no admin
   exists, no row is inserted -- operator backfills later.

Down migration drops the table cleanly.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_members",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "added_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint(
            "project_id", "user_id", name="pk_project_members"
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member', 'viewer')",
            name="ck_project_members_role",
        ),
    )
    op.create_index(
        "ix_project_members_user_id",
        "project_members",
        ["user_id"],
    )

    # Backfill 1: every project with a non-null owner_id -> owner row.
    op.execute(
        """
        INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
        SELECT p.id, p.owner_id, 'owner', NULL, now()
        FROM projects p
        WHERE p.owner_id IS NOT NULL
        ON CONFLICT (project_id, user_id) DO NOTHING
        """
    )

    # Backfill 2: projects with NULL owner_id -> oldest admin (if any).
    # Today projects.owner_id is NOT NULL, so this is a no-op in
    # practice; kept for forward compatibility / safety.
    op.execute(
        """
        INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
        SELECT
            p.id,
            (
                SELECT u.id
                FROM users u
                WHERE u.role = 'admin'
                ORDER BY u.created_at ASC
                LIMIT 1
            ) AS user_id,
            'owner',
            NULL,
            now()
        FROM projects p
        WHERE p.owner_id IS NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.role = 'admin')
        ON CONFLICT (project_id, user_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_table("project_members")
