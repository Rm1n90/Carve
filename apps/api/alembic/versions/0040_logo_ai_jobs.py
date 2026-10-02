"""logo_ai_jobs + logo_ai_batch_parts -- Logo AI run state.

Revision ID: 0040
Revises: 0039
Create Date: 2026-09-30

Logo AI detects logos through hosted vision LLMs (Anthropic / OpenAI),
either immediately or through the providers' batch APIs, which answer
within 24 hours at half the price.

A batch outlives anything kept in Redis, and losing track of one means
paying for results that are never collected, so runs are rows:

* ``logo_ai_jobs`` -- one per run: what was asked for, where it is, what
  it has cost. Also the resume cursor for the chunked RQ jobs.
* ``logo_ai_batch_parts`` -- one per batch submitted to the provider on
  behalf of a job, with the geometry needed to turn its results back
  into annotations without re-reading the images.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _uuid_pk() -> sa.Column:
    return sa.Column(
        "id",
        postgresql.UUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
        nullable=False,
    )


def _int(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer(), nullable=False, server_default="0")


def _ts(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=True)


def upgrade() -> None:
    op.create_table(
        "logo_ai_jobs",
        _uuid_pk(),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("delivery", sa.String(length=16), nullable=False),
        sa.Column("provider", sa.String(length=24), nullable=False),
        sa.Column("model", sa.String(length=80), nullable=False),
        sa.Column("effort", sa.String(length=16), nullable=True),
        sa.Column(
            "params",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "status", sa.String(length=24), nullable=False, server_default="queued"
        ),
        _int("total_assets"),
        _int("cursor"),
        _int("done_assets"),
        _int("failed_assets"),
        _int("skipped_assets"),
        _int("annotations_created"),
        _int("total_requests"),
        _int("finished_requests"),
        sa.Column(
            "usage",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Float(), nullable=True),
        sa.Column(
            "errors",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        _ts("started_at"),
        _ts("submitted_at"),
        _ts("last_polled_at"),
        _ts("expires_at"),
        _ts("completed_at"),
    )
    op.create_index("ix_logo_ai_jobs_task_id", "logo_ai_jobs", ["task_id"])
    op.create_index("ix_logo_ai_jobs_status", "logo_ai_jobs", ["status"])

    op.create_table(
        "logo_ai_batch_parts",
        _uuid_pk(),
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("logo_ai_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="submitted"
        ),
        sa.Column("provider_batch_id", sa.String(length=128), nullable=True),
        sa.Column("provider_file_id", sa.String(length=128), nullable=True),
        sa.Column(
            "ended", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        _int("request_count"),
        _int("finished_count"),
        sa.Column(
            "meta",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_logo_ai_batch_parts_job_id", "logo_ai_batch_parts", ["job_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_logo_ai_batch_parts_job_id", table_name="logo_ai_batch_parts")
    op.drop_table("logo_ai_batch_parts")
    op.drop_index("ix_logo_ai_jobs_status", table_name="logo_ai_jobs")
    op.drop_index("ix_logo_ai_jobs_task_id", table_name="logo_ai_jobs")
    op.drop_table("logo_ai_jobs")
