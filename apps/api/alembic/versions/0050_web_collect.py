"""Collect from web: keywords, runs, tried addresses, look-alike hashes.

Revision ID: 0050
Revises: 0049
Create Date: 2026-11-07

See carve_api.web_collect.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "web_collect_keywords",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("keyword", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(80), nullable=False),
        sa.Column("target", sa.Integer, nullable=False, server_default="100"),
        sa.Column("added", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_index", sa.Integer, nullable=False, server_default="1"),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("steps", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_web_collect_keywords_task_id", "web_collect_keywords", ["task_id"])
    # One row per keyword in a task, whatever its case.
    op.create_index(
        "uq_web_collect_keywords_task_keyword", "web_collect_keywords",
        ["task_id", sa.text("lower(keyword)")], unique=True,
    )

    op.create_table(
        "web_collect_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("options", JSONB, nullable=False, server_default="{}"),
        sa.Column("target", sa.Integer, nullable=False, server_default="0"),
        sa.Column("added", sa.Integer, nullable=False, server_default="0"),
        sa.Column("found", sa.Integer, nullable=False, server_default="0"),
        sa.Column("downloaded", sa.Integer, nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rejected", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rejected_by", JSONB, nullable=False, server_default="{}"),
        sa.Column("source_stats", JSONB, nullable=False, server_default="{}"),
        sa.Column("searches", sa.Integer, nullable=False, server_default="0"),
        sa.Column("notice", sa.Text, nullable=True),
        sa.Column("resume_after", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("stalls", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_web_collect_jobs_task_id", "web_collect_jobs", ["task_id"])
    op.create_index("ix_web_collect_jobs_status", "web_collect_jobs", ["status"])

    op.create_table(
        "web_collect_job_keywords",
        sa.Column("job_id", UUID(as_uuid=True), sa.ForeignKey("web_collect_jobs.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("keyword_id", UUID(as_uuid=True), sa.ForeignKey("web_collect_keywords.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("keyword", sa.String(200), nullable=False),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("want", sa.Integer, nullable=False, server_default="0"),
        sa.Column("added", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rejected", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
    )

    op.create_table(
        "web_collect_urls",
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("url_hash", sa.String(40), primary_key=True),
        sa.Column("url", sa.Text, nullable=False),
        sa.Column("page_url", sa.Text, nullable=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("keyword_id", UUID(as_uuid=True), sa.ForeignKey("web_collect_keywords.id", ondelete="SET NULL"), nullable=True),
        sa.Column("outcome", sa.String(24), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("dhash", sa.BigInteger, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # The next run starts with a keyword's pending addresses.
    op.create_index(
        "ix_web_collect_urls_pending", "web_collect_urls", ["task_id", "keyword_id"],
        postgresql_where=sa.text("outcome = 'pending'"),
    )
    op.create_index("ix_web_collect_urls_asset_id", "web_collect_urls", ["asset_id"])

    op.create_table(
        "web_collect_hashes",
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("dhash", sa.BigInteger, nullable=False),
        sa.Column("from_collector", sa.Boolean, nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_web_collect_hashes_task_id", "web_collect_hashes", ["task_id"])


def downgrade() -> None:
    op.drop_table("web_collect_hashes")
    op.drop_table("web_collect_urls")
    op.drop_table("web_collect_job_keywords")
    op.drop_table("web_collect_jobs")
    op.drop_table("web_collect_keywords")
