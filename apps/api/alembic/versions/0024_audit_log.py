"""audit_events -- append-only audit log table.

Revision ID: 0024
Revises: 0023
Create Date: 2026-05-01

Plan-13 Phase 7 Task 3 -- introduces an ``audit_events`` table that
captures user-driven mutations across review / retrain / export / task
operations. Writes are best-effort (the recorder swallows failures so
the underlying business action still completes), and the table is read
through a project-scoped GET endpoint guarded by the membership ACL.

Indexes are tuned for the three expected access patterns:

  * ``(project_id, occurred_at desc)`` -- per-project timeline (the
    primary read pattern from the audit panel).
  * ``(actor_id,   occurred_at desc)`` -- "what did this user do
    recently" admin views.
  * ``(action,     occurred_at desc)`` -- filtering by action type.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=False),
        sa.Column(
            "target_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
    )
    op.create_index(
        "ix_audit_events_project_occurred_at",
        "audit_events",
        ["project_id", sa.text("occurred_at DESC")],
    )
    op.create_index(
        "ix_audit_events_actor_occurred_at",
        "audit_events",
        ["actor_id", sa.text("occurred_at DESC")],
    )
    op.create_index(
        "ix_audit_events_action_occurred_at",
        "audit_events",
        ["action", sa.text("occurred_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_audit_events_action_occurred_at", table_name="audit_events"
    )
    op.drop_index(
        "ix_audit_events_actor_occurred_at", table_name="audit_events"
    )
    op.drop_index(
        "ix_audit_events_project_occurred_at", table_name="audit_events"
    )
    op.drop_table("audit_events")
