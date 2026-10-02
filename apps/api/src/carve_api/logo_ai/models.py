# Armin Mehri — mehri.armin@gmail.com
"""Persistent state for Logo AI runs.

A provider batch can take up to 24 hours, far longer than the Redis
progress hashes the GPU batches use are meant to live, and losing track
of one means paying for results that are never collected. So runs are
rows: ``logo_ai_jobs`` for the run, ``logo_ai_batch_parts`` for each
batch submitted to the provider on its behalf. See alembic 0040.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base

DELIVERY_REALTIME = "realtime"
DELIVERY_BATCH = "batch"
# One image, run synchronously from the editor. Recorded (already
# finished) so its tokens and cost are on the books like any other run.
DELIVERY_SINGLE = "single"

# queued → running                                      (realtime)
# queued → preparing → submitted → ingesting            (batch)
# then one of the terminal states. ``canceling`` is a batch waiting for
# the provider to stop so the results it already paid for can be kept.
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_PREPARING = "preparing"
STATUS_SUBMITTED = "submitted"
STATUS_INGESTING = "ingesting"
STATUS_CANCELING = "canceling"
STATUS_COMPLETED = "completed"
STATUS_COMPLETED_WITH_ERRORS = "completed_with_errors"
STATUS_FAILED = "failed"
STATUS_CANCELED = "canceled"

TERMINAL_STATUSES = frozenset(
    {STATUS_COMPLETED, STATUS_COMPLETED_WITH_ERRORS, STATUS_FAILED, STATUS_CANCELED}
)

# A part is written down before it is handed to the provider, so a
# crash between the two can be told apart from "never sent". It is also
# where a part goes back to when the provider could not take it yet.
PART_PENDING = "pending"      # recorded here, (re)send it to the provider
PART_SUBMITTED = "submitted"  # provider is processing it
PART_INGESTED = "ingested"    # results written as annotations
PART_FAILED = "failed"        # provider rejected the whole batch


class LogoAiJob(Base):
    __tablename__ = "logo_ai_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    delivery: Mapped[str] = mapped_column(String(16), nullable=False)
    provider: Mapped[str] = mapped_column(String(24), nullable=False)
    model: Mapped[str] = mapped_column(String(80), nullable=False)
    effort: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # The validated request (prompts, references, detail, tiling, …).
    params: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=STATUS_QUEUED, index=True
    )

    total_assets: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Assets taken off the list so far (prepared, for a batch). The
    # resume point when a chunk is retried.
    cursor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Assets with a final outcome: annotated, skipped or failed.
    done_assets: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_assets: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_assets: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    annotations_created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Detected boxes the second pass scored as not a logo and dropped.
    rejected_boxes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Batch only: requests handed to the provider / answered by it.
    total_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    finished_requests: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    usage: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Last few per-asset failures ("name: reason") and the run-level one.
    errors: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Waiting on something outside the run (provider or storage down,
    # the provider's batch queue full): what for, and when the next
    # attempt is due. The supervisor restarts the run at that time.
    notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    resume_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Waits in a row, and restarts by the supervisor in a row after the
    # run stopped without saying why. Both reset when the run advances.
    pauses: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    stalls: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LogoAiBatchPart(Base):
    """One batch submitted to the provider for a job.

    A job is split into parts so a single request body stays well under
    the provider's size limit — and, on Anthropic, so there is progress
    to show at all: its per-request counts only appear once a whole
    batch has ended.
    """

    __tablename__ = "logo_ai_batch_parts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("logo_ai_jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=PART_SUBMITTED)
    provider_batch_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider_file_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Whether the provider has finished; ingestion follows separately.
    ended: Mapped[bool] = mapped_column(nullable=False, default=False)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    finished_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # What is needed to turn a result back into annotations without
    # re-reading the image: per asset, the frame, the original size and
    # the geometry of every view sent.
    #   {"assets": [{"asset_id", "frame_id", "name", "w", "h",
    #                "views": [[index, x0, y0, x1, y1, out_w, out_h, is_tile], …]}]}
    # Plus the part's own bookkeeping: "attempt" (which send this is),
    # "staged_at", "counted", "adopted", "generation" (resubmissions of
    # unanswered requests), "wait" / "retry_after", "read_failures".
    meta: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class LogoAiTaskPrompt(Base):
    """A task's own instructions for Logo AI, where it has any.

    What counts as a logo differs between tasks: a set of sportswear
    photos and a set of storefronts want different rules. The text here
    replaces the default instructions in the prompt; the description of
    coordinates, output rows and classes is added after it and is not
    part of what can be edited. ``NULL`` in either column means the
    default text.
    """

    __tablename__ = "logo_ai_task_prompts"

    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    # The detection instructions, and those of the second pass.
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    check_instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
