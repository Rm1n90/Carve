# Armin Mehri — mehri.armin@gmail.com
"""Persistent state for collecting web images. See alembic 0050.

* ``web_collect_keywords`` — a task's keywords: how many images each
  should hold and how many it has, and how far each source and variant
  has been searched. Survives runs, so "collect more" is raising a
  target and running again, and it searches on from where it stopped.
* ``web_collect_jobs`` / ``web_collect_job_keywords`` — a run, and what
  it has to add for each keyword.
* ``web_collect_urls`` — every address a task has tried, kept or not,
  so no image is downloaded twice, rejected ones included.
* ``web_collect_hashes`` — a look-alike hash of every image in the
  task, to catch the same picture resized or recompressed.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base

SOURCE_BING = "bing"
SOURCE_YANDEX = "yandex"
SOURCE_COMMONS = "commons"
SOURCE_OPENVERSE = "openverse"
SOURCE_UNSPLASH = "unsplash"
SOURCE_PEXELS = "pexels"
SOURCE_PIXABAY = "pixabay"
SOURCES = (
    SOURCE_BING,
    SOURCE_YANDEX,
    SOURCE_COMMONS,
    SOURCE_OPENVERSE,
    SOURCE_UNSPLASH,
    SOURCE_PEXELS,
    SOURCE_PIXABAY,
)
# Bing and the open-licence archives find what a keyword names. Yandex
# answers only a page or so before asking for a CAPTCHA, so it is
# opt-in; the free photo sites return good photos of general subjects
# but rarely a given brand, so they are opt-in too.
DEFAULT_SOURCES = (SOURCE_BING, SOURCE_COMMONS, SOURCE_OPENVERSE)

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_CANCELING = "canceling"
STATUS_COMPLETED = "completed"
STATUS_CANCELED = "canceled"
STATUS_FAILED = "failed"
ACTIVE_STATUSES = frozenset({STATUS_QUEUED, STATUS_RUNNING, STATUS_CANCELING})
TERMINAL_STATUSES = frozenset({STATUS_COMPLETED, STATUS_CANCELED, STATUS_FAILED})

# A keyword within a run.
KW_PENDING = "pending"
KW_RUNNING = "running"
KW_DONE = "done"  # reached what the run had to add
KW_EXHAUSTED = "exhausted"  # every source and variant searched to the end
# What it still needed was only on sources dropped from the run (a limit,
# a CAPTCHA, a block). The run does not wait for them: it ends short.
KW_LIMITED = "limited"

# What became of an address.
OUTCOME_PENDING = "pending"  # found, not tried yet: the next run starts with these
OUTCOME_ADDED = "added"
OUTCOME_FAILED = "failed"  # could not be downloaded
# Anything else is a rejection reason (see images.REJECT_*).


class WebCollectKeyword(Base):
    __tablename__ = "web_collect_keywords"
    __table_args__ = (
        # One row per keyword in a task, whatever its case.
        Index(
            "uq_web_collect_keywords_task_keyword", "task_id", text("lower(keyword)"), unique=True
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    keyword: Mapped[str] = mapped_column(String(200), nullable=False)
    # File-name stem: "Tenneco logo" → "tenneco_logo".
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    # Images this keyword should hold in the task.
    target: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    # Images added for it so far, over all runs.
    added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Number of the next file: tenneco_logo_000042.jpg.
    next_index: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Search position per "source:variant", kept across runs so
    # "collect more" goes deeper instead of re-reading the first pages:
    # {"bing:tall": {"cursor": 140, "done": false, "empty": 0}, …}.
    steps: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class WebCollectJob(Base):
    __tablename__ = "web_collect_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=STATUS_QUEUED, index=True
    )
    # Sources, minimum size, filters (see router.RunOptionsIn).
    options: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Images the run has to add, over all its keywords.
    target: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Candidates looked at (found by a search, not blocked, not seen before).
    found: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    downloaded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejected: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # {reason: count}, rejections and blocked addresses.
    rejected_by: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Per source: {"searches", "found", "added", "status" (ok / error /
    # stopped), "note"} — which sources worked, and which were dropped why.
    source_stats: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    searches: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Waiting on something outside the run (a source pausing us, the
    # filters' model service down): what, until when.
    notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    resume_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    stalls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WebCollectJobKeyword(Base):
    __tablename__ = "web_collect_job_keywords"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("web_collect_jobs.id", ondelete="CASCADE"), primary_key=True
    )
    keyword_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("web_collect_keywords.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Copied from the keyword, so the run reads the same after an edit.
    keyword: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    want: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejected: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=KW_PENDING)


class WebCollectUrl(Base):
    __tablename__ = "web_collect_urls"
    __table_args__ = (
        # The next run starts with a keyword's pending addresses.
        Index(
            "ix_web_collect_urls_pending",
            "task_id",
            "keyword_id",
            postgresql_where=text("outcome = 'pending'"),
        ),
    )

    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    # sha1 of the normalised address.
    url_hash: Mapped[str] = mapped_column(String(40), primary_key=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    page_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    keyword_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("web_collect_keywords.id", ondelete="SET NULL"),
        nullable=True,
    )
    outcome: Mapped[str] = mapped_column(String(24), nullable=False)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Look-alike hash of a rejected image, so the same picture found at
    # another address is turned away without asking the filters again.
    dhash: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class WebCollectHash(Base):
    __tablename__ = "web_collect_hashes"

    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True
    )
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    dhash: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # False: computed from the thumbnail of an image added some other way.
    from_collector: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
