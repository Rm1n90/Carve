"""classes.parent_class_id -- self-referential is-a hierarchy

Revision ID: 0034
Revises: 0033
Create Date: 2026-05-17

v3.31 -- adds a nullable, self-referential ``parent_class_id`` column
to ``classes`` so a class can declare its general parent (e.g. "Racing
Car" is a kind of "Car"). The auto-annotate worker uses the hierarchy
to drop the more general (ancestor) annotation when it overlaps the
more specific (descendant) one above an IoU floor. This prevents the
duplicate-label-at-same-pixels problem for hyponymy taxonomies
(Car/Racing Car, Person/Pedestrian, Vehicle/Car, etc.).

``ON DELETE SET NULL`` so deleting a parent class merely orphans its
children rather than cascading-removing them. Cycle prevention is
enforced at the API layer (the DB cannot enforce it without recursive
checks); a max depth of 8 keeps the parent-chain walk bounded.

Down migration drops the column.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "classes",
        sa.Column(
            "parent_class_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("classes.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Helpful for "list every direct child of class X" lookups used by
    # the editor's hierarchy badge. The most common query path is
    # ``WHERE project_id=? ORDER BY idx`` (already indexed) which loads
    # all classes at once and resolves parents client-side, so the index
    # here is for the occasional reverse lookup only.
    op.create_index(
        "ix_classes_parent_class_id",
        "classes",
        ["parent_class_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_classes_parent_class_id", table_name="classes")
    op.drop_column("classes", "parent_class_id")
