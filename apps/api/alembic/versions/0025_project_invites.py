"""project_invites -- per-project invitation flow.

Revision ID: 0025
Revises: 0024
Create Date: 2026-05-01

Plan-13 Phase 7 Task 4 -- introduces a ``project_invites`` table that
records pending email invitations to per-project membership.

Key design notes:

* ``token_hash`` stores the SHA-256 hex digest of the raw token. The
  raw token is returned to the inviter exactly once (in the POST
  response) and never persisted or logged.
* ``role`` is a plain text column guarded by a CHECK constraint
  matching ``project_members.role`` -- adding a new role later does not
  require an ALTER TYPE migration.
* The two indexes support the only read patterns we need:
  ``(project_id, accepted_at)`` for the per-project pending list, and
  ``(email, accepted_at)`` for the duplicate-invite check.

Down migration drops the table cleanly.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "invited_by",
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
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False
        ),
        sa.Column(
            "accepted_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "accepted_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member', 'viewer')",
            name="ck_project_invites_role",
        ),
    )
    op.create_index(
        "ix_project_invites_project_accepted",
        "project_invites",
        ["project_id", "accepted_at"],
    )
    op.create_index(
        "ix_project_invites_email_accepted",
        "project_invites",
        ["email", "accepted_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_project_invites_email_accepted", table_name="project_invites"
    )
    op.drop_index(
        "ix_project_invites_project_accepted", table_name="project_invites"
    )
    op.drop_table("project_invites")
