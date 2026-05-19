"""projects.default_sam_variant -- per-project preferred SAM variant

Revision ID: 0035
Revises: 0034
Create Date: 2026-05-17

v3.32 -- adds a nullable ``default_sam_variant`` text column to
``projects`` so a project owner / workspace admin can pin which SAM
variant the editor should prefer when this project is opened.

Motivation: the model service has ONE loaded SAM at a time. After
process restarts or idle eviction, the API loses its in-memory
``_active_sam_variant`` cache and falls back to ``settings.sam_model``
(env default), which is typically ``sam2.1-tiny``. The editor then
shows the env default even though the user previously picked
``sam3.1`` on the SAM page. Persisting the preference per-project
fixes the inconsistency reported by the user: "Whatever the SAM
weight page is selected as default that one should be activated in
the Task editor unless user change it by it self".

The column is nullable (``NULL`` means "no project preference -- fall
back to workspace default"). Validation against the allowed-variant
list lives at the API layer (see ``_AVAILABLE_SAM_VARIANTS`` in
models_info/router.py); the DB stays permissive so the allow-list can
evolve without a schema migration.

Down migration drops the column.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op


revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "default_sam_variant",
            sa.Text(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "default_sam_variant")
