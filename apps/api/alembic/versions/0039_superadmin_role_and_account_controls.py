"""superadmin role, account blocking, session revocation, project suspension

Revision ID: 0039
Revises: 0038
Create Date: 2026-09-01

Adds a tier above ``admin``. The workspace previously had a flat admin
role in which every admin could promote, demote and delete every other
admin — an escalation path with no adult in the room. ``superadmin``
becomes the only role that may manage admin accounts, reset another
user's password, block an account, revoke its sessions, purge the trash
or suspend a project.

Four mechanisms ship with it:

* ``users.blocked_at`` / ``blocked_by`` / ``blocked_reason`` — a blocked
  account cannot log in and its in-flight requests start failing
  immediately, because every authenticated request re-reads the row.
* ``users.sessions_valid_from`` — "force logout". Access and refresh
  tokens carry an ``iat``; any token issued before this timestamp is
  rejected. Stamped on password reset and on demand.
* ``projects.suspended_at`` / ``suspended_by`` — freezes a project so
  only a superadmin can mutate it. Intended for a finished outsourced
  job whose annotations must not change after delivery.

Bootstrap: the workspace's oldest surviving admin is promoted to
superadmin, so an existing deployment always has exactly one. On a fresh
install the first registered user becomes superadmin instead (see
``AuthService.register``).
"""
import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0039"
down_revision: str = "0038"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ``ALTER TYPE ... ADD VALUE`` cannot be followed by a statement that
    # *uses* the new label inside the same transaction, so the label is
    # added in its own autocommit block. IF NOT EXISTS keeps a partially
    # applied migration re-runnable.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin'")

    op.add_column(
        "users",
        sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "blocked_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column("users", sa.Column("blocked_reason", sa.Text(), nullable=True))
    op.add_column(
        "users",
        sa.Column("sessions_valid_from", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_users_blocked_at", "users", ["blocked_at"])

    op.add_column(
        "projects",
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "projects",
        sa.Column(
            "suspended_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Promote the oldest surviving admin. Deliberately a no-op when the
    # workspace already has a superadmin, and when it has no admin at all
    # (a fresh database — register() handles that case).
    op.execute(
        """
        UPDATE users
           SET role = 'superadmin'
         WHERE id = (
                 SELECT id FROM users
                  WHERE role = 'admin' AND deleted_at IS NULL
                  ORDER BY created_at, id
                  LIMIT 1
               )
           AND NOT EXISTS (
                 SELECT 1 FROM users
                  WHERE role = 'superadmin' AND deleted_at IS NULL
               )
        """
    )


def downgrade() -> None:
    # Demote superadmins back to admin before the columns disappear;
    # the enum label itself is intentionally left in place because
    # PostgreSQL cannot drop a value from an enum type.
    op.execute("UPDATE users SET role = 'admin' WHERE role = 'superadmin'")
    op.drop_column("projects", "suspended_by")
    op.drop_column("projects", "suspended_at")
    op.drop_index("ix_users_blocked_at", table_name="users")
    op.drop_column("users", "sessions_valid_from")
    op.drop_column("users", "blocked_reason")
    op.drop_column("users", "blocked_by")
    op.drop_column("users", "blocked_at")
