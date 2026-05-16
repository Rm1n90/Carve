"""class_keybindings: per-user, per-project digit shortcut bindings.

Revision ID: 0033
Revises: 0032
Create Date: 2026-05-16

Adds the ``class_keybindings`` table so each user can bind digits 1-9
to any 9 of a project's classes. PK ``(user_id, project_id, digit)``
allows one class per digit per user-project. UNIQUE ``(user_id,
project_id, class_id)`` enforces one digit per class so the same class
never shows two ``[N]`` badges. ON DELETE CASCADE on project_id and
class_id keeps the table consistent without app-level cleanup.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | Sequence[str] | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "class_keybindings",
        sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("digit", sa.SmallInteger(), nullable=False),
        sa.Column("class_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["class_id"], ["classes.id"], ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "project_id", "digit",
            name="pk_class_keybindings",
        ),
        sa.UniqueConstraint(
            "user_id", "project_id", "class_id",
            name="uq_class_keybindings_user_project_class",
        ),
        sa.CheckConstraint(
            "digit BETWEEN 1 AND 9",
            name="ck_class_keybindings_digit_range",
        ),
    )
    op.create_index(
        "ix_class_keybindings_user_project",
        "class_keybindings",
        ["user_id", "project_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_class_keybindings_user_project",
        table_name="class_keybindings",
    )
    op.drop_table("class_keybindings")
