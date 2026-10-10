"""logo_ai_project_prompts -- Logo AI instructions per project.

Revision ID: 0047
Revises: 0046
Create Date: 2026-10-09

The instructions were per task, so a new task in a project started from
the logo default and had to be set up again. They are now per project,
with a task's own text still taking precedence. Each project also keeps
the description it last ran each class with, so the dialog can refill
its rows on any browser.

Data: a project whose tasks had their own instructions takes the most
recently saved one as its own, and task rows identical to it are
removed (the task then follows the project). Class descriptions are
seeded from the project's most recent run that used each class.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "logo_ai_project_prompts",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("instructions", sa.Text(), nullable=True),
        sa.Column("check_instructions", sa.Text(), nullable=True),
        sa.Column(
            "class_descriptions", postgresql.JSONB(), nullable=False, server_default="{}"
        ),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.execute(
        """
        INSERT INTO logo_ai_project_prompts
            (project_id, instructions, check_instructions, updated_by, updated_at)
        SELECT DISTINCT ON (t.project_id)
               t.project_id, p.instructions, p.check_instructions, p.updated_by, p.updated_at
        FROM logo_ai_task_prompts p JOIN tasks t ON t.id = p.task_id
        ORDER BY t.project_id, p.updated_at DESC
        """
    )
    op.execute(
        """
        DELETE FROM logo_ai_task_prompts p
        USING tasks t, logo_ai_project_prompts pp
        WHERE t.id = p.task_id AND pp.project_id = t.project_id
          AND p.instructions IS NOT DISTINCT FROM pp.instructions
          AND p.check_instructions IS NOT DISTINCT FROM pp.check_instructions
        """
    )
    op.execute(
        """
        WITH used AS (
            SELECT DISTINCT ON (t.project_id, e->>'class_id')
                   t.project_id, e->>'class_id' AS class_id, e->>'prompt' AS prompt
            FROM logo_ai_jobs j
            JOIN tasks t ON t.id = j.task_id
            CROSS JOIN LATERAL jsonb_array_elements(j.params->'prompts') e
            WHERE coalesce(e->>'class_id', '') <> '' AND btrim(coalesce(e->>'prompt', '')) <> ''
            ORDER BY t.project_id, e->>'class_id', j.created_at DESC
        ), per_project AS (
            SELECT project_id, jsonb_object_agg(class_id, prompt) AS descriptions
            FROM used GROUP BY project_id
        )
        INSERT INTO logo_ai_project_prompts (project_id, class_descriptions)
        SELECT project_id, descriptions FROM per_project
        ON CONFLICT (project_id) DO UPDATE
            SET class_descriptions = EXCLUDED.class_descriptions
        """
    )


def downgrade() -> None:
    op.drop_table("logo_ai_project_prompts")
