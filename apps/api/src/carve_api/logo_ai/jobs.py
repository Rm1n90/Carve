# Armin Mehri — mehri.armin@gmail.com
"""RQ callables for Logo AI runs.

    run_logo_ai_realtime       every asset, now, a few requests at a time
    run_logo_ai_batch_submit   build + submit provider batches (50% price)
    poll_logo_ai_batch         check provider batches, ingest finished ones

All three are resumable from the job row. Each takes a bounded bite of
work, commits, and re-enqueues itself, so no run is bounded by an RQ
timeout and a killed worker loses at most the step in flight.

What a run may never do is lose something that was paid for, or pay for
the same thing twice. The rules that keep that true:

* **A part is written down before it is sent.** A batch part is
  committed as ``pending``, with exactly what it contains, before the
  provider hears of it. If the process dies in between, the next
  execution asks the provider whether the batch exists and adopts it;
  only if it does not is the part sent again.
* **Results are copied before they are read.** A finished part's raw
  results go to our own storage first (``archive``) and are parsed from
  there, inside the transaction that marks the part ingested.
* **Waiting is not failing.** When the provider, the network or the
  image store is away, the run records what it is waiting for and when
  it will try again, and the supervisor (``enqueue_stalled_runs``)
  restarts it. The same supervisor restarts a run whose RQ job is gone
  for any other reason. Requests a batch never got to, and parts the
  provider's queue had no room for, are sent again by themselves.
* **One execution per run.** A run holds a database lock while it
  works, so a restart can never overlap the execution it replaces.
* **A run with batches at the provider does not end** until each one
  has been read, or the provider no longer has it, or a person gives it
  up with a forced stop.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from botocore.exceptions import ConnectionError as StorageConnectionError
from botocore.exceptions import HTTPClientError
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from carve_api.assets.models import Asset, Frame
from carve_api.config import get_settings
from carve_api.db import get_session_factory
from carve_api.errors import AppError
from carve_api.logo_ai import archive, providers
from carve_api.logo_ai.detections import persist_detections
from carve_api.logo_ai.imaging import View, load_image
from carve_api.logo_ai.models import (
    DELIVERY_BATCH,
    DELIVERY_REALTIME,
    PART_FAILED,
    PART_INGESTED,
    PART_PENDING,
    PART_SUBMITTED,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_COMPLETED,
    STATUS_COMPLETED_WITH_ERRORS,
    STATUS_FAILED,
    STATUS_INGESTING,
    STATUS_PREPARING,
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_SUBMITTED,
    TERMINAL_STATUSES,
    LogoAiBatchPart,
    LogoAiJob,
)
from carve_api.logo_ai.providers.base import (
    BatchGone,
    LogoAiNotConfigured,
    ProviderClient,
    ProviderFatal,
    ProviderResult,
    RunContext,
    Usage,
    api_error_message,
)
from carve_api.logo_ai.service import (
    AssetOutcome,
    LogoAiBadRequest,
    RunOptions,
    annotated_frame_ids,
    build_context,
    build_view_requests,
    detect_image,
    first_frames,
    interpret,
    read_image_bytes,
    render_views,
    scoped_assets,
    views_for,
)
from carve_api.projects.models import Task

log = logging.getLogger(__name__)

# Assets attempted per RQ execution of the realtime runner.
REALTIME_CHUNK_ASSETS = 100
# A run whose requests keep failing for reasons of their own (not an
# outage: that makes the run wait instead) is stopped rather than
# allowed to walk the whole asset list.
MAX_CONSECUTIVE_FAILURES = 20
# A realtime request that failed for a passing reason while its
# neighbours got through is tried again after these waits (seconds).
# Rate limits (Flex capacity being short, mostly) get more patience: they
# clear within a minute or two, and the alternative is a failed image.
_ASSET_RETRY_WAITS = (5.0, 20.0)
_RATE_LIMIT_RETRY_WAITS = (5.0, 20.0, 45.0, 90.0)

# One provider batch. Small enough that its base64 body is comfortable
# to hold in memory and far below both vendors' size limits; many parts
# rather than one also gives the progress bar something to move on.
# ``None`` takes the request count from the settings (300 by default).
PART_MAX_REQUESTS: int | None = None
PART_MAX_BYTES = 64 * 1024 * 1024
# Parts submitted / ingested per RQ execution before yielding the worker.
SUBMIT_PARTS_PER_RUN = 4
INGEST_PARTS_PER_RUN = 4
# Images decoded and resized at once while building a part.
_PREP_SLICE = 16
# A failed hand-over is tried once more after a short wait (on top of
# the SDK's own retries) before the run steps back and waits.
_SUBMIT_ATTEMPTS = 2
_SUBMIT_RETRY_WAIT = 10.0  # seconds
# How long a run waits before trying again, by how many waits in a row.
_PAUSES = (
    timedelta(seconds=30),
    timedelta(minutes=1),
    timedelta(minutes=2),
    timedelta(minutes=4),
    timedelta(minutes=8),
    timedelta(minutes=15),
)
# Restarts in a row of a run that stopped without a word, before it is
# closed out instead; and hand-overs of one part that died in the act.
_MAX_STALLS = 10
_MAX_SENDS = 8
# A run younger than this may simply not have been queued yet.
_NEW_RUN_GRACE = timedelta(seconds=45)
# How long past a batch's 24h window its results are still chased. Both
# vendors keep a finished batch's results for about a month (OpenAI 30
# days after it completes, Anthropic 29 after it was created), and they
# are paid for, so a part is only written off as unreadable once the
# provider can no longer have them — or says so itself (`BatchGone`).
_RESULTS_KEPT = timedelta(days=27)
# Wait between attempts to read a finished part that failed to read:
# doubles from the first value up to the second.
_READ_RETRY_FIRST = timedelta(minutes=1)
_READ_RETRY_MAX = timedelta(hours=1)
# A part the provider's batch queue had no room for is offered again
# this often, one part at a time, for at most this long.
_QUEUE_RETRY = timedelta(minutes=10)
_QUEUE_PROBE_GAP = timedelta(minutes=3)
_QUEUE_WAIT_MAX = timedelta(days=7)
# How long the provider must keep saying it has no such batch before
# that is believed. An API key swapped for another account's says the
# same thing, and is put right by swapping it back.
_GONE_GRACE = timedelta(hours=24)
# Times a request the provider never got to (its batch ran out of time)
# is sent again in a new part.
_MAX_RESUBMITS = 2
# Result errors that mean "this code could not read the answer" rather
# than "the provider reported a problem".
_READER_ERRORS = frozenset({"unreadable_result", "empty_answer", "no_result"})
# Request errors that come and go and say nothing about the image.
_PASSING_ERRORS = frozenset(
    {
        "rate_limited",
        "provider_unreachable",
        "storage_unreachable",
        "provider_error_408",
        "provider_error_409",
    }
)
# SDK errors (same names in both SDKs) that mean no answer came at all.
_UNREACHABLE = frozenset({"APIConnectionError", "APITimeoutError"})
_REASONS = {
    "rate_limited": "the provider is rate limiting the account, or it is out of credit",
    "provider_unreachable": "the provider cannot be reached",
    "storage_unreachable": "the image storage cannot be reached",
}


def _now() -> datetime:
    return datetime.now(UTC)


class _TryLater(Exception):
    """Nothing is wrong with the run; what it needs is away. It waits
    and is started again, from what it last committed."""

    def __init__(self, error: str) -> None:
        super().__init__(error)
        self.reason = _REASONS.get(error) or (
            "the provider is having trouble"
            if error.startswith("provider_error_")
            else error or "the provider cannot be reached"
        )


class _NotOurBatch(Exception):
    """A batch adopted for a part turned out to hold other requests."""


def _passing(error: str | None) -> bool:
    return bool(error) and (error in _PASSING_ERRORS or error.startswith("provider_error_5"))


def _push_error(job: LogoAiJob, message: str) -> None:
    # Reassign: in-place mutation of a JSONB list is not tracked.
    job.errors = [*(job.errors or []), message][-50:]


def _add_usage(job: LogoAiJob, usage: Usage, cost_usd: float) -> None:
    total = Usage.from_dict(job.usage)
    total.add(usage)
    job.usage = total.to_dict()
    job.cost_usd = round((job.cost_usd or 0.0) + cost_usd, 6)


def _progressed(job: LogoAiJob) -> None:
    """The run got somewhere: it is neither waiting nor stuck."""
    job.notice = None
    job.resume_after = None
    job.pauses = 0
    job.stalls = 0


def _fail(session: Session, job: LogoAiJob, message: str) -> dict:
    job.status = STATUS_FAILED
    job.error = message[:1000]
    job.completed_at = _now()
    job.notice = None
    job.resume_after = None
    session.commit()
    log.warning("logo_ai.job.failed job_id=%s error=%s", job.id, message)
    return {"ok": False, "error": message}


def _finish(session: Session, job: LogoAiJob, *, canceled: bool = False) -> dict:
    if canceled:
        job.status = STATUS_CANCELED
    elif job.failed_assets > 0:
        job.status = STATUS_COMPLETED_WITH_ERRORS
    else:
        job.status = STATUS_COMPLETED
    job.completed_at = _now()
    job.notice = None
    job.resume_after = None
    session.commit()
    return {"ok": True, "status": job.status}


def _pause(session: Session, job: LogoAiJob, reason: str) -> dict:
    """Step back and let the supervisor start the run again later.

    Commits. The caller has rolled back to the last thing the run
    finished, so nothing half-done is kept and nothing done is lost.
    """
    wait = _PAUSES[min(job.pauses or 0, len(_PAUSES) - 1)]
    job.pauses = (job.pauses or 0) + 1
    job.notice = f"Waiting: {reason}. The run continues by itself."[:500]
    job.resume_after = _now() + wait
    session.commit()
    log.warning("logo_ai.job.waiting job_id=%s reason=%s wait=%s", job.id, reason, wait)
    return {"ok": False, "waiting": True, "reason": reason}


def _stop_requested(session: Session, job: LogoAiJob) -> bool:
    """Whether the API has asked this run to stop (or already ended it).

    Reads the column directly instead of refreshing ``job``: a refresh
    would throw away counters this execution has not committed yet.
    """
    status = session.execute(
        select(LogoAiJob.status).where(LogoAiJob.id == job.id)
    ).scalar_one_or_none()
    return status is None or status == STATUS_CANCELING or status in TERMINAL_STATUSES


def _no_tokens_spent(job: LogoAiJob) -> bool:
    return not any((job.usage or {}).values())


@contextmanager
def _exclusive(session: Session, job_id: uuid.UUID) -> Iterator[bool]:
    """Hold the run for this execution. Yields whether it was free.

    A PostgreSQL advisory lock on a connection of its own: it outlives
    the session's commits, and the server drops it when the process
    dies, however it dies. So a run restarted by the supervisor or by
    RQ can never work alongside the execution it replaces.
    """
    key = int.from_bytes(job_id.bytes[:8], "big", signed=True)
    conn = session.get_bind().engine.connect()
    held = False
    try:
        held = bool(conn.execute(select(func.pg_try_advisory_lock(key))).scalar())
        conn.commit()
        yield held
    finally:
        try:
            if held:
                conn.execute(select(func.pg_advisory_unlock(key)))
                conn.commit()
            conn.close()
        except Exception:  # noqa: BLE001
            # Never hand a connection that may still hold the lock back
            # to the pool.
            log.warning("logo_ai.lock.release_failed job_id=%s", job_id, exc_info=True)
            conn.invalidate()


def _lock_job(session: Session, job_id: uuid.UUID, *, wait: bool = False) -> LogoAiJob | None:
    """The job row, locked for this transaction. Without ``wait``,
    ``None`` when another transaction holds it. Serialises everything
    that changes a job's counters once its batches are with the provider."""
    query = (
        select(LogoAiJob)
        .where(LogoAiJob.id == job_id)
        # Reload the row: counters may have moved since this session
        # last saw it, and they are about to be incremented.
        .execution_options(populate_existing=True)
    )
    query = query.with_for_update() if wait else query.with_for_update(skip_locked=True)
    return session.execute(query).scalar_one_or_none()


@dataclass
class _Loaded:
    job: LogoAiJob
    options: RunOptions
    ctx: RunContext
    client: ProviderClient


def _load(session: Session, job: LogoAiJob, *, for_results: bool = False) -> _Loaded:
    """Rebuild the run's constants. Raises AppError if it can't be run.

    ``for_results`` is for reading a batch back: it leaves out what is
    only needed to build requests, so less can stand in its way.
    """
    task = session.get(Task, job.task_id)
    if task is None:
        raise LogoAiBadRequest("task no longer exists")
    options = RunOptions.from_dict(job.params)
    ctx = build_context(session, task, options, with_references=not for_results)
    return _Loaded(job=job, options=options, ctx=ctx, client=providers.make_client(ctx))


def _local_error(exc: Exception) -> str:
    """Name a failure to fetch or decode an image. The image store being
    away is told apart: that passes, a broken image does not."""
    if isinstance(
        exc, StorageConnectionError | HTTPClientError | ConnectionError | TimeoutError
    ):
        return "storage_unreachable"
    return type(exc).__name__


# ---------------------------------------------------------------------------
# Realtime
# ---------------------------------------------------------------------------


def _detect_asset(run: _Loaded, asset: Asset, frame: Frame) -> AssetOutcome:
    """Worker-thread body: fetch, resize, call the provider. No DB."""
    try:
        return detect_image(
            run.client, run.ctx, run.options, read_image_bytes(asset, frame)
        )
    except ProviderFatal:
        raise
    except Exception as exc:  # noqa: BLE001 — one bad asset must not end the run
        log.exception("logo_ai.asset.failed asset_id=%s", asset.id)
        return AssetOutcome(error=_local_error(exc))


def _detect_group(
    pool: ThreadPoolExecutor, run: _Loaded, todo: list[tuple[Asset, Frame]]
) -> list[AssetOutcome]:
    """Every asset of a group, at once. A request that failed for a
    passing reason while others got through is tried again; if nothing
    got through, that is an outage and is left to the caller."""
    outcomes = list(pool.map(lambda pair: _detect_asset(run, *pair), todo))
    for n, wait in enumerate(_RATE_LIMIT_RETRY_WAITS):
        again = [i for i, o in enumerate(outcomes) if _passing(o.error)]
        if not again or len(again) == len(todo):
            break
        if n >= len(_ASSET_RETRY_WAITS) and not all(
            outcomes[i].error == "rate_limited" for i in again
        ):
            break
        time.sleep(wait)
        for i, outcome in zip(
            again, pool.map(lambda i: _detect_asset(run, *todo[i]), again), strict=True
        ):
            # Views of the failed attempt that did answer were billed.
            outcome.usage.add(outcomes[i].usage)
            outcomes[i] = outcome
    return outcomes


def _record_outcome(
    session: Session,
    run: _Loaded,
    *,
    asset_name: str,
    frame_id: uuid.UUID,
    outcome: AssetOutcome,
) -> None:
    """Put one image's result on the books: its usage and cost (priced
    when it was interpreted), and its boxes or its failure."""
    job = run.job
    _add_usage(job, outcome.usage, outcome.cost_usd)
    job.done_assets += 1
    job.rejected_boxes = (job.rejected_boxes or 0) + outcome.rejected
    if outcome.served_at_full_price and run.ctx.flex:
        # Priced at Flex, served (and billed) as standard by the provider.
        # It happens rarely, but it must not happen quietly.
        _push_error(
            job,
            f"{asset_name}: served at the standard price, not Flex "
            f"({outcome.served_at_full_price} request"
            f"{'' if outcome.served_at_full_price == 1 else 's'})",
        )
    error = outcome.error
    if not error:
        try:
            # A savepoint of its own: one image whose boxes cannot be
            # saved fails alone instead of undoing its neighbours.
            with session.begin_nested():
                result = persist_detections(
                    session,
                    task_id=job.task_id,
                    frame_id=frame_id,
                    actor_id=job.created_by,
                    class_ids=[uuid.UUID(c.class_id) for c in run.ctx.classes],
                    dets=outcome.detections,
                    min_confidence=float(run.options.min_confidence),
                    min_visible=int(run.options.min_visible),
                    overwrite=bool(run.options.overwrite),
                )
        except Exception as exc:  # noqa: BLE001
            log.exception("logo_ai.persist.failed frame_id=%s", frame_id)
            error = f"could not be saved ({type(exc).__name__})"
        else:
            job.annotations_created += len(result.annotations)
            return
    job.failed_assets += 1
    _push_error(job, f"{asset_name}: {error}")


def run_logo_ai_realtime(job_id: str) -> dict:
    session = get_session_factory()()
    try:
        job = session.get(LogoAiJob, uuid.UUID(job_id))
        if job is None or job.status in TERMINAL_STATUSES:
            return {"ok": True, "skipped": True}
        with _exclusive(session, job.id) as mine:
            if not mine:
                return {"ok": True, "skipped": "busy"}
            session.refresh(job)
            if job.status in TERMINAL_STATUSES:
                return {"ok": True, "skipped": True}
            return _realtime(session, job, job_id)
    finally:
        session.close()


def _realtime(session: Session, job: LogoAiJob, job_id: str) -> dict:
    if job.status == STATUS_CANCELING:
        return _finish(session, job, canceled=True)
    try:
        run = _load(session, job)
    except LogoAiNotConfigured as exc:
        # A missing key is a deployment slip; the run picks up when it
        # is back.
        return _pause(session, job, exc.message)
    except AppError as exc:
        return _fail(session, job, exc.message)

    assets = scoped_assets(session, job.task_id, run.options.asset_ids)
    if job.status == STATUS_QUEUED:
        job.status = STATUS_RUNNING
        job.started_at = _now()
        job.total_assets = len(assets)
        session.commit()

    skip_frames = (
        annotated_frame_ids(session, job.task_id)
        if run.options.skip_annotated
        else set()
    )
    concurrency = max(1, get_settings().logo_ai_concurrency)
    window_end = min(job.cursor + REALTIME_CHUNK_ASSETS, len(assets))
    consecutive_failures = 0

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        while job.cursor < window_end:
            if _stop_requested(session, job):
                return _finish(session, job, canceled=True)
            # Until a request has succeeded, send one at a time: the
            # first writes the prompt cache (the others can only read
            # it once that response has begun) and proves the request
            # shape before the run fans out.
            warming = _no_tokens_spent(job)
            group = assets[
                job.cursor : min(job.cursor + (1 if warming else concurrency), window_end)
            ]
            frames = first_frames(session, group)

            todo: list[tuple[Asset, Frame]] = []
            for asset in group:
                frame = frames.get(asset.id)
                if frame is None:
                    job.done_assets += 1
                    job.failed_assets += 1
                    _push_error(job, f"{asset.original_name}: no_frames_extracted")
                elif frame.id in skip_frames:
                    job.done_assets += 1
                    job.skipped_assets += 1
                else:
                    todo.append((asset, frame))

            try:
                outcomes = _detect_group(pool, run, todo)
            except ProviderFatal as exc:
                session.rollback()
                return _fail(session, job, exc.message)

            if todo and all(_passing(o.error) for o in outcomes):
                # Nothing got through: an outage, not these images. They
                # are not marked failed and the cursor stays on them.
                session.rollback()
                for outcome in outcomes:
                    # A view that did answer before the rest failed was billed.
                    _add_usage(job, outcome.usage, outcome.cost_usd)
                return _pause(session, job, _TryLater(outcomes[0].error or "").reason)

            for (asset, frame), outcome in zip(todo, outcomes, strict=True):
                if warming and (outcome.error or "").startswith("bad_request"):
                    # The provider rejected the request itself, not
                    # this image; every other asset would fail too.
                    session.rollback()
                    return _fail(session, job, outcome.error)
                consecutive_failures = (
                    consecutive_failures + 1 if outcome.error else 0
                )
                _record_outcome(
                    session,
                    run,
                    asset_name=asset.original_name,
                    frame_id=frame.id,
                    outcome=outcome,
                )
            job.cursor += len(group)
            _progressed(job)
            # Annotations, counters and the resume cursor land
            # together, so a retried chunk never repeats an asset.
            session.commit()

            full_price = sum(o.served_at_full_price for o in outcomes)
            if run.ctx.flex and full_price:
                # The run was priced at Flex. The provider served (and
                # bills) these at the standard rate, which this code
                # never asks for. What was served is kept and booked at
                # its real price; nothing more is sent, so the bill
                # cannot drift from the estimate by more than the few
                # requests that were in flight.
                return _fail(
                    session,
                    job,
                    f"Stopped: the provider served {full_price} request"
                    f"{'' if full_price == 1 else 's'} at the standard price although "
                    "Flex was asked for. Nothing more was sent and the cost shown is "
                    "exact. Run the remaining images with “Skip annotated” when you "
                    "want to continue.",
                )

            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                last = (job.errors or ["unknown"])[-1]
                return _fail(
                    session,
                    job,
                    f"stopped after {consecutive_failures} consecutive failures "
                    f"(last: {last})",
                )

    if job.cursor >= len(assets):
        return _finish(session, job)
    enqueue(run_logo_ai_realtime, job_id, suffix=f"-c{job.cursor}")
    return {"ok": True, "status": "continued", "cursor": job.cursor}


# ---------------------------------------------------------------------------
# Batch — parts and their hand-over to the provider
# ---------------------------------------------------------------------------


@dataclass
class _Prepared:
    asset: Asset
    frame: Frame
    width: int = 0
    height: int = 0
    views: list[View] | None = None
    requests: list[dict] | None = None
    size: int = 0
    error: str | None = None


def _prepare_asset(run: _Loaded, asset: Asset, frame: Frame) -> _Prepared:
    """Worker-thread body: fetch + resize + build this asset's requests."""
    prepared = _Prepared(asset=asset, frame=frame)
    try:
        im: Image.Image = load_image(read_image_bytes(asset, frame))
        prepared.width, prepared.height = im.width, im.height
        prepared.views = views_for(run.ctx, run.options, im.width, im.height)
        jpegs = render_views(im, prepared.views)
        prepared.requests = build_view_requests(
            run.client, run.ctx, prepared.views, jpegs, batch=True
        )
        # Each request repeats the prompt prefix, exemplars included.
        prefix = len(run.ctx.system_text) + sum(len(r.jpeg) for r in run.ctx.references)
        prepared.size = (sum(len(j) for j in jpegs) + prefix * len(jpegs)) * 4 // 3
    except Exception as exc:  # noqa: BLE001
        log.exception("logo_ai.prepare.failed asset_id=%s", asset.id)
        prepared.error = _local_error(exc)
    return prepared


def _custom_id_prefix(part: LogoAiBatchPart) -> str:
    """Starts every request id of a part, so results read back from a
    batch can be shown to be this part's."""
    return f"{part.id.hex}-"


def _tag(part: LogoAiBatchPart) -> str:
    """Names one attempt at sending a part."""
    return f"{part.id.hex}-{int(part.meta.get('attempt', 1))}"


def _staged_at(part: LogoAiBatchPart) -> datetime:
    staged = part.meta.get("staged_at")
    return datetime.fromisoformat(staged) if staged else part.created_at


def _sent_at(part: LogoAiBatchPart) -> datetime:
    sent = part.meta.get("sent_at")
    return datetime.fromisoformat(sent) if sent else _staged_at(part)


def _waiting_to_retry(part: LogoAiBatchPart) -> bool:
    retry_after = part.meta.get("retry_after")
    return bool(retry_after) and _now() < datetime.fromisoformat(retry_after)


def _write_off(job: LogoAiJob, part: LogoAiBatchPart, reason: str) -> None:
    """Give up on a part: every asset in it counts as failed."""
    part.status = PART_FAILED
    part.ended = True
    part.error = reason
    n = len(part.meta.get("assets", []))
    job.done_assets += n
    job.failed_assets += n
    _push_error(job, f"batch part {part.seq}: {reason}")


def _pending_parts(session: Session, job_id: uuid.UUID) -> list[LogoAiBatchPart]:
    return list(
        session.execute(
            select(LogoAiBatchPart)
            .where(
                LogoAiBatchPart.job_id == job_id,
                LogoAiBatchPart.status == PART_PENDING,
            )
            .order_by(LogoAiBatchPart.seq)
            .execution_options(populate_existing=True)
        ).scalars()
    )


def _known_batch_ids(session: Session) -> set[str]:
    """Provider batches some part already owns."""
    since = _now() - timedelta(days=40)
    return set(
        session.execute(
            select(LogoAiBatchPart.provider_batch_id).where(
                LogoAiBatchPart.provider_batch_id.is_not(None),
                LogoAiBatchPart.created_at > since,
            )
        ).scalars()
    )


def _stage_part(
    session: Session, run: _Loaded, items: list[_Prepared], seq: int
) -> tuple[LogoAiBatchPart, list[tuple[str, dict]]]:
    """Write a part down, as ``pending``, with everything needed to read
    its results or to build it again. The caller commits before the
    provider hears of it."""
    part = LogoAiBatchPart(
        id=uuid.uuid4(), job_id=run.job.id, seq=seq, status=PART_PENDING, meta={}
    )
    prefix = _custom_id_prefix(part)
    requests: list[tuple[str, dict]] = []
    meta_assets: list[dict] = []
    for ai, p in enumerate(items):
        assert p.views is not None and p.requests is not None
        meta_assets.append(
            {
                "asset_id": str(p.asset.id),
                "frame_id": str(p.frame.id),
                "name": p.asset.original_name,
                "w": p.width,
                "h": p.height,
                "views": [v.as_list() for v in p.views],
            }
        )
        for view, request in zip(p.views, p.requests, strict=True):
            requests.append((f"{prefix}{ai}_{view.index}", request))
    part.request_count = len(requests)
    part.meta = {"assets": meta_assets, "attempt": 1, "staged_at": _now().isoformat()}
    session.add(part)
    return part, requests


def _rebuild_requests(
    session: Session, run: _Loaded, part: LogoAiBatchPart
) -> list[tuple[str, dict]]:
    """A recorded part's requests, built again from its images, with the
    same ids and the same views it was recorded with."""
    entries = part.meta.get("assets", [])
    assets = {
        a.id: a
        for a in session.execute(
            select(Asset).where(Asset.id.in_([uuid.UUID(e["asset_id"]) for e in entries]))
        ).scalars()
    }
    frames = {
        f.id: f
        for f in session.execute(
            select(Frame).where(Frame.id.in_([uuid.UUID(e["frame_id"]) for e in entries]))
        ).scalars()
    }
    prefix = _custom_id_prefix(part)
    requests: list[tuple[str, dict]] = []
    for ai, entry in enumerate(entries):
        asset = assets.get(uuid.UUID(entry["asset_id"]))
        frame = frames.get(uuid.UUID(entry["frame_id"]))
        if asset is None or frame is None:
            # Deleted since. Its result will be missing and the asset
            # reported as such; the positions of the others do not move.
            continue
        try:
            im = load_image(read_image_bytes(asset, frame))
            views = [View.from_list(v) for v in entry["views"]]
            built = build_view_requests(
                run.client, run.ctx, views, render_views(im, views), batch=True
            )
        except Exception as exc:  # noqa: BLE001
            if _local_error(exc) == "storage_unreachable":
                raise _TryLater("storage_unreachable") from exc
            log.exception("logo_ai.rebuild.failed asset_id=%s", asset.id)
            continue
        requests.extend(
            (f"{prefix}{ai}_{view.index}", request)
            for view, request in zip(views, built, strict=True)
        )
    if not requests:
        raise ProviderFatal("none of its images can be read any more")
    return requests


def _find(
    run: _Loaded, part: LogoAiBatchPart, known: set[str]
) -> tuple[str, str | None] | None:
    """The batch an interrupted attempt to send this part left behind.

    Not being able to ask is not an answer: the part must then wait,
    because sending it again could pay for it twice.
    """
    try:
        return run.client.batch_find(
            _tag(part),
            request_count=part.request_count,
            since=_staged_at(part),
            known=known,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("logo_ai.find.failed part=%s", part.id, exc_info=True)
        raise _TryLater("provider_unreachable") from exc


def _create_batch(
    run: _Loaded,
    part: LogoAiBatchPart,
    build: Callable[[], list[tuple[str, dict]]],
    known: set[str],
) -> tuple[str, str | None, bool]:
    """Hand a recorded part to the provider. Returns the batch id, the
    input file id and whether the batch was found rather than made.

    Raises :class:`ProviderFatal` when the provider refuses the part and
    :class:`_TryLater` when it cannot be reached.
    """
    client = run.client
    tag = _tag(part)
    requests: list[tuple[str, dict]] | None = None
    error = "provider_unreachable"
    for attempt in range(1, _SUBMIT_ATTEMPTS + 1):
        try:
            if part.provider_file_id:
                # Uploaded on an earlier attempt: no need to send the
                # images again.
                batch_id = client.batch_create_from_file(part.provider_file_id, tag=tag)
                if batch_id:
                    return batch_id, part.provider_file_id, False
            if requests is None:
                requests = build()
            batch_id, file_id = client.batch_create(requests, tag=tag)
            return batch_id, file_id, False
        except (ProviderFatal, _TryLater):
            raise
        except Exception as exc:  # noqa: BLE001 — network, rate limit, 5xx
            log.warning(
                "logo_ai.submit.attempt_failed part=%s attempt=%s",
                part.id, attempt, exc_info=True,
            )
            status = getattr(exc, "status_code", None)
            error = "rate_limited" if status == 429 else "provider_unreachable"
            uploaded = getattr(exc, "uploaded_file_id", None)
            if uploaded and not part.provider_file_id:
                # The upload got through; only starting the batch did
                # not. Keep the file for the next attempt, and on record
                # so it is deleted with the part. Nothing else is
                # uncommitted at this point.
                part.provider_file_id = uploaded
                session = object_session(part)
                if session is not None:
                    session.commit()
        # The provider may have taken the batch without its answer
        # reaching us. Look before trying again.
        found = _find(run, part, known)
        if found:
            return found[0], found[1], True
        if attempt < _SUBMIT_ATTEMPTS:
            time.sleep(_SUBMIT_RETRY_WAIT)
    raise _TryLater(error)


def _apply_sent(
    job: LogoAiJob,
    part: LogoAiBatchPart,
    batch_id: str,
    file_id: str | None,
    *,
    adopted: bool,
) -> None:
    """Record that the provider has the part. No commit."""
    part.provider_batch_id = batch_id
    part.provider_file_id = file_id or part.provider_file_id
    part.status = PART_SUBMITTED
    part.ended = False
    part.finished_count = 0
    part.error = None
    meta = {
        k: v
        for k, v in part.meta.items()
        if k not in ("retry_after", "wait", "sends", "waits", "adopted", "read_failures")
    }
    meta["sent_at"] = _now().isoformat()
    if adopted:
        meta["adopted"] = True
    if not meta.get("counted"):
        job.total_requests += part.request_count
        meta["counted"] = True
    part.meta = meta


def _mark_sent(
    session: Session,
    run: _Loaded,
    part: LogoAiBatchPart,
    batch_id: str,
    file_id: str | None,
    *,
    adopted: bool,
) -> bool:
    """Commit a hand-over. False if the part was closed meanwhile (the
    run was canceled or force-stopped): the batch is then called off."""
    job = _lock_job(session, run.job.id, wait=True)
    session.refresh(part)
    if job is None or part.status != PART_PENDING or job.status in TERMINAL_STATUSES:
        session.commit()
        try:
            run.client.batch_cancel(batch_id)
        except Exception:  # noqa: BLE001
            log.warning("logo_ai.submit.cancel_failed batch=%s", batch_id, exc_info=True)
        return False
    run.job = job
    _apply_sent(job, part, batch_id, file_id, adopted=adopted)
    _progressed(job)
    session.commit()
    return True


def _send_pending(
    session: Session, run: _Loaded, part: LogoAiBatchPart, known: set[str]
) -> None:
    """Get a recorded part to the provider: adopt the batch an earlier
    attempt left there, or make one. Commits."""
    found = _find(run, part, known)
    if found:
        _mark_sent(session, run, part, found[0], found[1], adopted=True)
        return
    batch_id, file_id, adopted = _create_batch(
        run, part, lambda: _rebuild_requests(session, run, part), known
    )
    _mark_sent(session, run, part, batch_id, file_id, adopted=adopted)


def _preflight(session: Session, run: _Loaded, prepared: _Prepared) -> str | None:
    """Run the job's first asset synchronously, with the batch's own
    request shape.

    Providers validate batch requests only when they get to them, so a
    malformed request would otherwise surface hours later as a fully
    failed batch. One realtime call up front catches that, and as a
    side effect writes the prompt cache the batch then reads from.
    Returns an error message if the run should not be submitted.
    """
    assert prepared.views is not None and prepared.requests is not None
    results: list[ProviderResult] = [run.client.send(r) for r in prepared.requests]
    first_error = next((r.error for r in results if r.error), None)
    if first_error and first_error.startswith("bad_request"):
        return first_error
    if _passing(first_error) and not any(
        v for r in results for v in r.usage.to_dict().values()
    ):
        # The provider could not be asked at all. That proves nothing
        # about the request: ask again later.
        raise _TryLater(first_error or "")
    outcome = interpret(
        run.ctx, results, prepared.views,
        image_w=prepared.width, image_h=prepared.height,
        batch=True,          # same cache TTL as the batch requests
        discounted=False,    # but billed at the realtime rate
    )
    _record_outcome(
        session,
        run,
        asset_name=prepared.asset.original_name,
        frame_id=prepared.frame.id,
        outcome=outcome,
    )
    return None


# ---------------------------------------------------------------------------
# Batch — submit
# ---------------------------------------------------------------------------


def run_logo_ai_batch_submit(job_id: str) -> dict:
    session = get_session_factory()()
    try:
        job = session.get(LogoAiJob, uuid.UUID(job_id))
        if job is None or job.status in TERMINAL_STATUSES:
            return {"ok": True, "skipped": True}
        with _exclusive(session, job.id) as mine:
            if not mine:
                return {"ok": True, "skipped": "busy"}
            session.refresh(job)
            if job.status in (STATUS_SUBMITTED, STATUS_INGESTING):
                return _resend(session, job, job_id)
            if job.status not in (STATUS_QUEUED, STATUS_PREPARING, STATUS_CANCELING):
                return {"ok": True, "skipped": True}
            return _submit(session, job, job_id)
    finally:
        session.close()


def _close_out(session: Session, job: LogoAiJob, message: str) -> dict:
    """End the submitting of a batch run that can submit nothing more.

    Parts that never reached the provider are counted as not submitted.
    If none did, the run has failed; otherwise it goes on to collect
    what the provider has, which is being paid for.
    """
    parts = list(
        session.execute(
            select(LogoAiBatchPart).where(LogoAiBatchPart.job_id == job.id)
        ).scalars()
    )
    for part in parts:
        if part.status == PART_PENDING:
            _write_off(job, part, f"not submitted: {message}")
    if not any(p.status == PART_SUBMITTED for p in parts):
        return _fail(session, job, message)
    unsent = max(0, job.total_assets - job.cursor)
    if unsent:
        job.done_assets += unsent
        job.failed_assets += unsent
        _push_error(
            job,
            f"{unsent} image{'' if unsent == 1 else 's'} not submitted: {message}. "
            "Run them again with “Skip annotated”.",
        )
    job.cursor = job.total_assets
    if job.status != STATUS_CANCELING:
        job.status = STATUS_SUBMITTED
    job.submitted_at = job.submitted_at or _now()
    job.expires_at = job.expires_at or job.submitted_at + timedelta(hours=24)
    job.notice = None
    job.resume_after = None
    session.commit()
    enqueue_poll(str(job.id))
    return {"ok": False, "status": job.status, "error": message}


def _submit(session: Session, job: LogoAiJob, job_id: str) -> dict:
    try:
        run = _load(session, job)
    except LogoAiNotConfigured as exc:
        return _pause(session, job, exc.message)
    except AppError as exc:
        return _close_out(session, job, exc.message)

    assets = scoped_assets(session, job.task_id, run.options.asset_ids)
    if job.status == STATUS_QUEUED:
        job.status = STATUS_PREPARING
        job.started_at = _now()
        job.total_assets = len(assets)
        session.commit()

    skip_frames = (
        annotated_frame_ids(session, job.task_id)
        if run.options.skip_annotated
        else set()
    )
    seq = (
        session.execute(
            select(LogoAiBatchPart.seq)
            .where(LogoAiBatchPart.job_id == job.id)
            .order_by(LogoAiBatchPart.seq.desc())
            .limit(1)
        ).scalar_one_or_none()
        or 0
    )
    known = _known_batch_ids(session)
    part_max_requests = PART_MAX_REQUESTS or max(
        1, get_settings().logo_ai_batch_part_requests
    )
    parts_this_run = 0
    pending: list[_Prepared] = []
    pending_size = 0
    pending_requests = 0
    position = job.cursor

    def flush() -> None:
        nonlocal seq, parts_this_run, pending, pending_size, pending_requests
        # Re-checked here, not just at the top of the loop: a part
        # submitted after a cancel would be paid for and never read.
        if pending and not _stop_requested(session, job):
            seq += 1
            part, requests = _stage_part(session, run, pending, seq)
            # The part and the cursor that covers it are on record
            # before the provider is called: whatever happens next, the
            # run knows this part may exist over there.
            job.cursor = position
            session.commit()
            batch_id, file_id, adopted = _create_batch(run, part, lambda: requests, known)
            _mark_sent(session, run, part, batch_id, file_id, adopted=adopted)
            parts_this_run += 1
        else:
            job.cursor = position
            session.commit()
        pending, pending_size, pending_requests = [], 0, 0

    try:
        # Parts an earlier execution recorded and did not get to hand
        # over — or did, without living to write it down.
        for part in _pending_parts(session, job.id):
            if _stop_requested(session, job):
                break  # the poll decides what becomes of them
            _send_pending(session, run, part, known)

        with ThreadPoolExecutor(max_workers=4) as pool:
            while position < len(assets) and parts_this_run < SUBMIT_PARTS_PER_RUN:
                if _stop_requested(session, job):
                    break
                # A slice is no larger than a part, so a small part size
                # is honoured.
                group = assets[position : position + min(_PREP_SLICE, part_max_requests)]
                frames = first_frames(session, group)

                # The first image that is sent at all goes alone and
                # now (the preflight), and is committed on its own, so
                # its cost is on record whatever happens after it.
                preflight = seq == 0 and not pending and _no_tokens_spent(job)
                if preflight:
                    first = next(
                        (
                            i
                            for i, a in enumerate(group)
                            if a.id in frames and frames[a.id].id not in skip_frames
                        ),
                        None,
                    )
                    if first is not None:
                        group = group[: first + 1]

                todo: list[tuple[Asset, Frame]] = []
                for asset in group:
                    frame = frames.get(asset.id)
                    if frame is None:
                        job.done_assets += 1
                        job.failed_assets += 1
                        _push_error(job, f"{asset.original_name}: no_frames_extracted")
                    elif frame.id in skip_frames:
                        job.done_assets += 1
                        job.skipped_assets += 1
                    else:
                        todo.append((asset, frame))

                for prepared in pool.map(lambda pair: _prepare_asset(run, *pair), todo):
                    if prepared.error == "storage_unreachable":
                        raise _TryLater(prepared.error)
                    if prepared.error:
                        job.done_assets += 1
                        job.failed_assets += 1
                        _push_error(
                            job, f"{prepared.asset.original_name}: {prepared.error}"
                        )
                    elif preflight:
                        error = _preflight(session, run, prepared)
                        if error:
                            session.rollback()
                            return _fail(session, job, error)
                    else:
                        assert prepared.requests is not None
                        pending.append(prepared)
                        pending_size += prepared.size
                        pending_requests += len(prepared.requests)
                # A slice is never split across parts, so the limits
                # are soft by at most one slice.
                position += len(group)
                if preflight:
                    job.cursor = position
                    _progressed(job)
                    session.commit()
                elif pending_requests >= part_max_requests or pending_size >= PART_MAX_BYTES:
                    flush()
            flush()
    except _TryLater as exc:
        # Back to the last thing committed. A part that was recorded and
        # not handed over stays recorded, and is looked for and sent
        # when the run starts again.
        session.rollback()
        session.refresh(job)
        return _pause(session, job, exc.reason)
    except ProviderFatal as exc:
        session.rollback()
        session.refresh(job)
        return _close_out(session, job, exc.message)

    session.refresh(job)
    if job.status in TERMINAL_STATUSES:
        return {"ok": True, "status": job.status}
    if position < len(assets) and job.status != STATUS_CANCELING:
        enqueue(run_logo_ai_batch_submit, job_id, suffix=f"-s{position}")
        return {"ok": True, "status": "continued", "cursor": position}

    open_part = session.execute(
        select(LogoAiBatchPart.id).where(
            LogoAiBatchPart.job_id == job.id,
            LogoAiBatchPart.status.in_([PART_SUBMITTED, PART_PENDING]),
        )
    ).first()
    if open_part is None:
        # Nothing is with the provider: every asset was skipped, failed
        # locally, or was the preflight asset.
        return _finish(session, job, canceled=job.status == STATUS_CANCELING)
    if job.status != STATUS_CANCELING:
        job.status = STATUS_SUBMITTED
    job.submitted_at = _now()
    job.expires_at = job.submitted_at + timedelta(hours=24)
    job.notice = None
    job.resume_after = None
    session.commit()
    enqueue_poll(job_id)
    return {"ok": True, "status": job.status, "requests": job.total_requests}


def _resend(session: Session, job: LogoAiJob, job_id: str) -> dict:
    """Send the parts of a run that is already being collected and that
    are not with the provider: ones its queue had no room for, and new
    ones made of requests an expired batch never ran."""
    parts = _pending_parts(session, job.id)
    if not parts:
        return {"ok": True, "skipped": True}
    try:
        run = _load(session, job)
    except LogoAiNotConfigured:
        return {"ok": False, "error": "not_configured"}
    except AppError as exc:
        job = _lock_job(session, job.id, wait=True)
        for part in _pending_parts(session, job.id):
            _write_off(job, part, f"not submitted: {exc.message}")
        session.commit()
        enqueue_poll(job_id)
        return {"ok": False, "error": exc.message}

    known = _known_batch_ids(session)
    sent = 0
    probed = False
    for part in parts:
        if _waiting_to_retry(part):
            continue
        queue_full = part.meta.get("wait") == "queue_full"
        if queue_full and probed:
            continue
        sends = int(part.meta.get("sends", 0)) + 1
        if sends > _MAX_SENDS:
            job = _lock_job(session, job.id, wait=True)
            session.refresh(part)
            if part.status == PART_PENDING:
                _write_off(
                    job, part, "not submitted: handing it to the provider kept failing"
                )
            session.commit()
            continue
        # Counted before the attempt, so one that kills the process
        # still counts. An attempt that fails cleanly is uncounted below.
        part.meta = {**part.meta, "sends": sends}
        session.commit()
        try:
            _send_pending(session, run, part, known)
        except _TryLater as exc:
            session.rollback()
            waits = int(part.meta.get("waits", 0)) + 1
            part.meta = {
                **part.meta,
                "sends": sends - 1,
                "waits": waits,
                "retry_after": (
                    _now() + _PAUSES[min(waits - 1, len(_PAUSES) - 1)]
                ).isoformat(),
            }
            session.commit()
            log.warning("logo_ai.resend.waiting part=%s reason=%s", part.id, exc.reason)
            break  # an outage: the others would fare no better
        except ProviderFatal as exc:
            session.rollback()
            job = _lock_job(session, job.id, wait=True)
            session.refresh(part)
            if part.status == PART_PENDING:
                _write_off(job, part, f"not submitted: {exc.message}")
            session.commit()
            continue
        sent += 1
        if queue_full:
            # One at a time: if the queue still has no room for this
            # one, it has none for the rest either.
            probed = True
            hold = (_now() + _QUEUE_PROBE_GAP).isoformat()
            for other in parts:
                if (
                    other is not part
                    and other.status == PART_PENDING
                    and other.meta.get("wait") == "queue_full"
                ):
                    other.meta = {
                        **other.meta,
                        "retry_after": max(other.meta.get("retry_after") or hold, hold),
                    }
            session.commit()
    enqueue_poll(job_id)
    return {"ok": True, "sent": sent}


# ---------------------------------------------------------------------------
# Batch — poll + ingest
# ---------------------------------------------------------------------------


def _results_expired(part: LogoAiBatchPart) -> bool:
    """Whether the provider has dropped the part's results by now."""
    return _now() > _sent_at(part) + timedelta(hours=24) + _RESULTS_KEPT


def _read_failed(job: LogoAiJob, part: LogoAiBatchPart, exc: Exception) -> None:
    """Note a failed attempt to read a finished part and put off the
    next one. The results stay where they are, so nothing is lost by
    waiting; the run's error list says it is being retried."""
    failures = int(part.meta.get("read_failures", 0)) + 1
    wait = min(_READ_RETRY_FIRST * 2 ** min(failures - 1, 10), _READ_RETRY_MAX)
    # Reassign: in-place mutation of a JSONB dict is not tracked.
    part.meta = {
        **part.meta,
        "read_failures": failures,
        "retry_after": (_now() + wait).isoformat(),
    }
    if failures == 1:
        _push_error(
            job,
            f"batch part {part.seq}: results could not be read yet, retrying "
            f"({api_error_message(exc)[:200]})",
        )


def _gone(job: LogoAiJob, part: LogoAiBatchPart, reason: str) -> None:
    """The provider says it does not have the part's batch or results.

    That is final if true, but the same answer comes back when the API
    key on this machine belongs to a different account than the one the
    batch was sent from. So it is noted, the run says so, and the part
    is only written off when the answer has stayed the same for a day.
    """
    since = part.meta.get("gone_since")
    if since is None:
        part.meta = {**part.meta, "gone_since": _now().isoformat()}
        _push_error(
            job,
            f"batch part {part.seq}: {reason}. If the provider API key was changed, "
            "put back the one the run was started with; otherwise the part is "
            "given up in 24 hours.",
        )
    elif _now() > datetime.fromisoformat(since) + _GONE_GRACE:
        _write_off(job, part, reason)


def _requeue_queue_full(
    parts: list[LogoAiBatchPart], part: LogoAiBatchPart
) -> None:
    """The provider's queue had no room for the part. Nothing ran and
    nothing was charged; it goes back to pending and is offered again
    later. Its uploaded file is kept, so that costs one small request."""
    retry_at = (_now() + _QUEUE_RETRY).isoformat()
    part.status = PART_PENDING
    part.ended = False
    part.finished_count = 0
    part.provider_batch_id = None
    part.meta = {
        **{k: v for k, v in part.meta.items() if k != "adopted"},
        "attempt": int(part.meta.get("attempt", 1)) + 1,
        "staged_at": _now().isoformat(),
        "wait": "queue_full",
        "retry_after": retry_at,
    }
    # No room for this one means no room for the others that wait.
    for other in parts:
        if (
            other is not part
            and other.status == PART_PENDING
            and other.meta.get("wait") == "queue_full"
        ):
            other.meta = {
                **other.meta,
                "retry_after": max(other.meta.get("retry_after") or retry_at, retry_at),
            }


def _raw_results(run: _Loaded, part: LogoAiBatchPart) -> bytes:
    """The part's results as the provider gave them: from our copy if
    there is one, else fetched and copied before anything reads them."""
    assert part.provider_batch_id is not None
    key = archive.key_for(run.job.id, part.seq, part.provider_batch_id)
    raw = archive.load(key)
    if raw is None:
        raw = run.client.batch_download(part.provider_batch_id)
        archive.save(key, raw)
    return raw


def _ingest_part(session: Session, run: _Loaded, part: LogoAiBatchPart) -> None:
    """Write one finished part's results as annotations. No commit: the
    caller commits annotations, counters and the part's status together,
    which is what makes ingestion exactly-once."""
    job = run.job
    canceling = job.status == STATUS_CANCELING
    entries = list(run.client.batch_parse(_raw_results(run, part)))
    prefix = _custom_id_prefix(part)
    results = {cid[len(prefix):]: r for cid, r in entries if cid.startswith(prefix)}
    if entries and not results:
        if part.meta.get("adopted"):
            raise _NotOurBatch
        raise RuntimeError("the results carry none of this part's request ids")

    assets = part.meta.get("assets", [])
    per_asset: list[list[ProviderResult]] = [
        [
            results.get(f"{ai}_{v[0]}") or ProviderResult(error="no_result")
            for v in a["views"]
        ]
        for ai, a in enumerate(assets)
    ]
    flat = [r for group in per_asset for r in group]
    if (
        not canceling
        and len(flat) >= 5
        and all(
            r.error in _READER_ERRORS or (r.error or "").startswith("bad_output")
            for r in flat
        )
    ):
        # Not one answer of a whole part could be read. That is this
        # code not understanding what came back, not the provider
        # failing every image: keep the part (and our copy of its
        # results) for a version that can read it.
        raise RuntimeError(
            f"none of the part's {len(flat)} answers could be read ({flat[0].error})"
        )

    live_frames = set(
        session.execute(
            select(Frame.id).where(
                Frame.id.in_([uuid.UUID(a["frame_id"]) for a in assets])
            )
        ).scalars()
    )
    generation = int(part.meta.get("generation", 0))
    unanswered: list[dict] = []
    for a, view_results in zip(assets, per_asset, strict=True):
        frame_id = uuid.UUID(a["frame_id"])
        if (
            not canceling
            and generation < _MAX_RESUBMITS
            and frame_id in live_frames
            and any(r.retryable for r in view_results)
        ):
            # The provider never ran (all of) this image: its batch ran
            # out of time, or it dropped the request. Not charged, and
            # worth sending again. What did run is on the bill.
            for r in view_results:
                cost = r.cost_usd(run.ctx.provider, run.ctx.model, batch=True, discounted=True)
                _add_usage(job, r.usage, cost)
            unanswered.append(a)
            continue
        views = [View.from_list(v) for v in a["views"]]
        outcome = interpret(
            run.ctx, view_results, views, image_w=a["w"], image_h=a["h"], batch=True
        )
        if not outcome.error and frame_id not in live_frames:
            outcome.error = "asset_deleted"
        _record_outcome(
            session,
            run,
            asset_name=a["name"],
            frame_id=frame_id,
            outcome=outcome,
        )

    if unanswered:
        last_seq = session.execute(
            select(func.max(LogoAiBatchPart.seq)).where(LogoAiBatchPart.job_id == job.id)
        ).scalar_one()
        session.add(
            LogoAiBatchPart(
                id=uuid.uuid4(),
                job_id=job.id,
                seq=last_seq + 1,
                status=PART_PENDING,
                request_count=sum(len(a["views"]) for a in unanswered),
                meta={
                    "assets": unanswered,
                    "attempt": 1,
                    "generation": generation + 1,
                    "staged_at": _now().isoformat(),
                },
            )
        )
        _push_error(
            job,
            f"batch part {part.seq}: the provider did not get to "
            f"{len(unanswered)} image{'' if len(unanswered) == 1 else 's'}; "
            "sent again automatically",
        )


def _cannot_read(session: Session, job: LogoAiJob, message: str) -> dict:
    """The run's results cannot be turned into boxes right now (a class
    it detects was deleted, say). They stay with the provider, and the
    run stays open, until that changes or the provider drops them."""
    note = f"results cannot be written: {message}"
    if note not in (job.errors or []):
        _push_error(job, note)
    parts = list(
        session.execute(
            select(LogoAiBatchPart).where(
                LogoAiBatchPart.job_id == job.id,
                LogoAiBatchPart.status.in_([PART_SUBMITTED, PART_PENDING]),
            )
        ).scalars()
    )
    if all(_results_expired(p) for p in parts):
        for part in parts:
            _write_off(job, part, note)
        if job.status == STATUS_CANCELING:
            return _finish(session, job, canceled=True)
        return _fail(session, job, note)
    job.last_polled_at = _now()
    session.commit()
    return {"ok": False, "error": message}


def poll_logo_ai_batch(job_id: str) -> dict:
    jid = uuid.UUID(job_id)
    session = get_session_factory()()
    try:
        job = _lock_job(session, jid)
        if job is None or job.status in TERMINAL_STATUSES:
            return {"ok": True, "skipped": True}
        if job.status not in (STATUS_SUBMITTED, STATUS_INGESTING, STATUS_CANCELING):
            return {"ok": True, "skipped": True}
        try:
            run = _load(session, job, for_results=True)
        except LogoAiNotConfigured:
            # A missing key is a deployment slip, not a reason to abandon
            # results that are already paid for. Try again next poll.
            session.rollback()
            log.error("logo_ai.poll.not_configured job_id=%s", job_id)
            return {"ok": False, "error": "not_configured"}
        except AppError as exc:
            return _cannot_read(session, job, exc.message)

        parts = list(
            session.execute(
                select(LogoAiBatchPart)
                .where(LogoAiBatchPart.job_id == jid)
                .order_by(LogoAiBatchPart.seq)
                .execution_options(populate_existing=True)
            ).scalars()
        )
        canceling = job.status == STATUS_CANCELING
        known: set[str] | None = None
        expiries: list[datetime] = []
        for part in parts:
            if part.status == PART_PENDING and canceling:
                # A canceled run sends nothing more. But the part may
                # have reached the provider without that being written
                # down; if so it is ours to stop and to read.
                if known is None:
                    known = _known_batch_ids(session)
                try:
                    found = _find(run, part, known)
                except _TryLater:
                    continue  # cannot tell yet; the next poll asks again
                if found is None:
                    _write_off(job, part, "not submitted")
                    continue
                _apply_sent(job, part, found[0], found[1], adopted=True)
            if part.ended or part.status != PART_SUBMITTED:
                continue
            try:
                if canceling:
                    run.client.batch_cancel(part.provider_batch_id)
                state = run.client.batch_state(part.provider_batch_id)
            except BatchGone:
                _gone(job, part, "the provider says it has no such batch")
                continue
            except Exception as exc:  # noqa: BLE001 — transient; the next poll retries
                log.exception("logo_ai.poll.state_failed part=%s", part.id)
                if _results_expired(part):
                    _write_off(job, part, "provider batch could not be read")
                elif type(exc).__name__ in _UNREACHABLE:
                    # The provider is not there at all: asking about the
                    # other parts would only wait out the same timeout,
                    # with the job row locked meanwhile.
                    break
                continue
            if "gone_since" in part.meta:
                part.meta = {k: v for k, v in part.meta.items() if k != "gone_since"}
            part.finished_count = min(part.request_count, state.finished)
            if state.expires_at and not state.ended:
                expiries.append(state.expires_at)
            if state.ended:
                part.ended = True
                part.finished_count = part.request_count
            if state.failed_reason:
                if (
                    state.queue_full
                    and not canceling
                    and _now() < part.created_at + _QUEUE_WAIT_MAX
                ):
                    _requeue_queue_full(parts, part)
                else:
                    _write_off(job, part, state.failed_reason)
        if expiries:
            job.expires_at = max(expiries)
        job.finished_requests = sum(
            p.finished_count for p in parts if p.status != PART_PENDING
        )
        job.last_polled_at = _now()
        queued = [
            p for p in parts
            if p.status == PART_PENDING and p.meta.get("wait") == "queue_full"
        ]
        job.notice = (
            f"Waiting: the provider's batch queue is full. {len(queued)} part"
            f"{'' if len(queued) == 1 else 's'} "
            f"({sum(p.request_count for p in queued)} requests) will be sent by "
            "themselves as earlier ones finish. Nothing is charged for them meanwhile."
            if queued
            else None
        )
        # Finished parts whose results can be read now; one that failed
        # to read sits out its wait first.
        ready = [
            p
            for p in parts
            if p.ended and p.status == PART_SUBMITTED and not _waiting_to_retry(p)
        ]
        if not canceling:
            # "Ingesting" is polled every few seconds, so it is only held
            # while there is something to write.
            job.status = STATUS_INGESTING if ready else STATUS_SUBMITTED
        session.commit()

        for part in ready[:INGEST_PARTS_PER_RUN]:
            job = _lock_job(session, jid)
            # Force-stopped from the API while this poll was reading.
            if job is None or job.status in TERMINAL_STATUSES:
                session.commit()
                return {"ok": True, "skipped": True}
            run.job = job
            session.refresh(part)
            if part.status != PART_SUBMITTED:
                session.commit()
                continue
            try:
                _ingest_part(session, run, part)
            except Exception as exc:  # noqa: BLE001 — the part is tried again later
                session.rollback()
                log.exception("logo_ai.ingest.failed part=%s", part.id)
                job = _lock_job(session, jid)
                if job is not None and job.status not in TERMINAL_STATUSES:
                    if isinstance(exc, BatchGone):
                        _gone(job, part, "the provider says it no longer has these results")
                        # Asked again at the pace of a failed read.
                        part.meta = {
                            **part.meta,
                            "retry_after": (_now() + _READ_RETRY_MAX).isoformat(),
                        }
                    elif isinstance(exc, _NotOurBatch):
                        # Nothing of ours ran, so nothing was charged.
                        _write_off(job, part, "not submitted")
                    elif _results_expired(part):
                        _write_off(job, part, "provider results could not be read")
                    else:
                        _read_failed(job, part, exc)
                session.commit()
                continue
            part.status = PART_INGESTED
            session.commit()
            run.client.batch_cleanup(part.provider_batch_id, part.provider_file_id)

        job = _lock_job(session, jid)
        if job is None or job.status in TERMINAL_STATUSES:
            session.commit()
            return {"ok": True, "skipped": True}
        open_parts = list(
            session.execute(
                select(LogoAiBatchPart)
                .where(
                    LogoAiBatchPart.job_id == jid,
                    LogoAiBatchPart.status.in_([PART_SUBMITTED, PART_PENDING]),
                )
                .execution_options(populate_existing=True)
            ).scalars()
        )
        if not open_parts:
            if job.annotations_created == 0 and job.done_assets == job.failed_assets:
                failed = next((p.error for p in parts if p.error), None)
                if failed and job.status != STATUS_CANCELING:
                    return _fail(session, job, failed)
            return _finish(session, job, canceled=job.status == STATUS_CANCELING)
        status = job.status
        resend = status != STATUS_CANCELING and any(
            p.status == PART_PENDING and not _waiting_to_retry(p) for p in open_parts
        )
        session.commit()
        if resend:
            enqueue_resend(job_id)
        if len(ready) > INGEST_PARTS_PER_RUN:
            # More finished parts are waiting; don't sit out a poll interval.
            enqueue_poll(job_id)
        return {"ok": True, "status": status}
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Enqueue helpers, the poll schedule and the supervisor
# ---------------------------------------------------------------------------


def enqueue(fn, job_id: str, *, suffix: str = "", connection=None) -> None:  # noqa: ANN001
    """Queue a run (or its next chunk). ``suffix`` keeps each chunk's RQ
    id distinct; the job row stays keyed by ``job_id``.

    Suffixes must not contain ``:``. RQ 2 treats everything after a
    colon as an execution id and resolves ``<id>:<anything>`` back to
    the job ``<id>`` — so a ``<job>::poll`` id would silently re-run
    the job's first RQ job instead of the poll.
    """
    from carve_api.jobs.queue import enqueue_resumable

    enqueue_resumable(fn, job_id, rq_job_id=f"{job_id}{suffix}", connection=connection)


def _enqueue_once(fn, job_id: str, suffix: str, connection=None) -> bool:  # noqa: ANN001
    """Queue ``fn`` under a fixed id unless it is already waiting or
    running there."""
    from rq.exceptions import NoSuchJobError
    from rq.job import Job

    from carve_api.jobs.queue import enqueue_resumable, rq_connection

    conn = connection or rq_connection()
    rq_id = f"{job_id}{suffix}"
    try:
        status = Job.fetch(rq_id, connection=conn).get_status(refresh=True)
        if status in ("queued", "started", "deferred", "scheduled"):
            return False
    except NoSuchJobError:
        pass
    # No RQ retry: the next scheduled poll is the retry. And the result
    # is the job row, so the RQ record is not worth keeping.
    enqueue_resumable(
        fn, job_id, rq_job_id=rq_id, connection=conn, retry=False, result_ttl=30
    )
    return True


def enqueue_poll(job_id: str, *, connection=None) -> bool:  # noqa: ANN001
    """Queue a poll unless one is already waiting or running."""
    return _enqueue_once(poll_logo_ai_batch, job_id, "-poll", connection)


def enqueue_resend(job_id: str, *, connection=None) -> bool:  # noqa: ANN001
    """Queue the sending of a collected run's pending parts, unless that
    is already waiting or running."""
    return _enqueue_once(run_logo_ai_batch_submit, job_id, "-resend", connection)


def _poll_interval(job: LogoAiJob, now: datetime) -> timedelta:
    if job.status != STATUS_SUBMITTED or job.submitted_at is None:
        # Ingesting or canceling: there is work to do right now.
        return timedelta(seconds=15)
    if job.expires_at is not None and now > job.expires_at:
        # Past the window the provider has nothing new to report; what
        # is left is a part that cannot be read yet.
        return timedelta(minutes=10)
    age = now - job.submitted_at
    if age < timedelta(minutes=15):
        return timedelta(seconds=20)
    if age < timedelta(hours=2):
        return timedelta(seconds=60)
    return timedelta(seconds=180)


def clear_dead_rq_jobs(connection=None) -> None:  # noqa: ANN001
    """Let RQ notice the jobs whose worker died under them.

    Such a job stays "started" until a worker's housekeeping runs, which
    is every ten minutes; meanwhile a poll with that id cannot be queued
    again, and a run's chunk is not retried. Doing the same housekeeping
    here, on every tick, brings that down to the ninety seconds RQ takes
    to consider a silent job dead.
    """
    from rq.registry import StartedJobRegistry

    from carve_api.jobs.queue import LANES, rq_connection

    conn = connection or rq_connection()
    for lane in LANES:
        StartedJobRegistry(lane, connection=conn).cleanup()


def enqueue_due_polls(session: Session, *, connection=None) -> int:  # noqa: ANN001
    """Queue a poll for every batch job whose next check is due.

    Driven by the API's poller thread (and opportunistically by the
    jobs endpoints), so results are collected whether or not anyone has
    the page open. The schedule lives in the job rows, not in Redis, so
    it survives a Redis flush or a worker restart.
    """
    now = _now()
    jobs = session.execute(
        select(LogoAiJob).where(
            LogoAiJob.delivery == DELIVERY_BATCH,
            LogoAiJob.status.in_([STATUS_SUBMITTED, STATUS_INGESTING, STATUS_CANCELING]),
        )
    ).scalars()
    queued = 0
    for job in jobs:
        due = job.last_polled_at is None or job.last_polled_at + _poll_interval(job, now) <= now
        if due and enqueue_poll(str(job.id), connection=connection):
            queued += 1
    return queued


def _rq_alive(conn, job_id: str) -> bool:  # noqa: ANN001
    """Whether RQ has anything waiting or running for the run (its
    polls aside, which are scheduled separately)."""
    from rq import Queue
    from rq.registry import StartedJobRegistry

    from carve_api.jobs.queue import LANES

    for lane in LANES:
        ids = list(Queue(lane, connection=conn).job_ids)
        # Reading this registry also clears out jobs whose worker died,
        # which is what frees a run (or a poll) stuck as "started".
        ids += StartedJobRegistry(lane, connection=conn).get_job_ids()
        for rq_id in ids:
            base = rq_id.split(":")[0]  # RQ 2 appends ":<execution id>"
            if (base == job_id or base.startswith(f"{job_id}-")) and not base.endswith(
                ("-poll", "-resend")
            ):
                return True
    return False


_RUNNERS: dict[str, Callable[[str], dict]] = {
    DELIVERY_REALTIME: run_logo_ai_realtime,
    DELIVERY_BATCH: run_logo_ai_batch_submit,
}


def enqueue_stalled_runs(session: Session, *, connection=None) -> int:  # noqa: ANN001
    """Start again every run that should be working and is not.

    A run works through a chain of RQ jobs. If the chain breaks — the
    machine lost power, the worker was killed more often than RQ
    retries, Redis lost its data, or the run stepped back to wait for
    the provider — the row still says "running" and nothing is behind
    it. This finds those rows and queues the run again; it resumes from
    what it last committed. Called from the API's poller thread.

    A run found with nothing behind it is only restarted the second
    time it is seen that way, so one caught between two of its own jobs
    is left alone. And if that ever misjudges, the run's lock stops the
    second execution at the door.
    """
    from carve_api.jobs.queue import rq_connection

    now = _now()
    conn = connection or rq_connection()
    jobs = list(
        session.execute(
            select(LogoAiJob).where(
                LogoAiJob.delivery.in_(list(_RUNNERS)),
                LogoAiJob.status.in_(
                    [STATUS_QUEUED, STATUS_RUNNING, STATUS_PREPARING, STATUS_CANCELING]
                ),
            )
        ).scalars()
    )
    started = 0
    for job in jobs:
        if job.status == STATUS_CANCELING and job.delivery == DELIVERY_BATCH:
            continue  # the poll winds a canceled batch down
        if job.resume_after is not None and job.resume_after > now:
            continue
        if job.created_at > now - _NEW_RUN_GRACE:
            continue
        marker = f"logo_ai:stalled:{job.id}"
        if _rq_alive(conn, str(job.id)):
            conn.delete(marker)
            continue
        if conn.set(marker, "1", nx=True, ex=120):
            continue  # first sighting; confirm on the next tick
        conn.delete(marker)

        if job.notice is not None:
            # It stepped back by itself and its wait is over. Should the
            # attempt die instead of reporting, the next one is not
            # before another wait has passed.
            job.resume_after = now + _PAUSES[min(job.pauses or 0, len(_PAUSES) - 1)]
        else:
            job.stalls = (job.stalls or 0) + 1
            if job.stalls > _MAX_STALLS:
                message = (
                    "the run kept stopping unexpectedly and was not started again. "
                    "What it wrote is kept; run the rest with “Skip annotated”."
                )
                if job.delivery == DELIVERY_BATCH:
                    _close_out(session, job, message)
                else:
                    _fail(session, job, message)
                continue
            # The first restart is immediate; a run that keeps dying is
            # given longer each time.
            job.resume_after = now + _PAUSES[min(job.stalls - 1, len(_PAUSES) - 1)]
            log.warning("logo_ai.supervisor.restart job_id=%s stalls=%s", job.id, job.stalls)
        session.commit()
        enqueue(
            _RUNNERS[job.delivery],
            str(job.id),
            suffix=f"-w{int(now.timestamp())}",
            connection=conn,
        )
        started += 1
    return started
