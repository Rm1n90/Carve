# Armin Mehri — mehri.armin@gmail.com
"""HTTP surface for Logo AI.

    GET  /inference/logo-ai/config             what is configured + allowed
    POST /assets/{id}/logo-ai/detect           one image, synchronously
    POST /tasks/{id}/logo-ai/estimate          tokens + cost before running
    POST /tasks/{id}/logo-ai/jobs              start a realtime or batch run
    GET  /tasks/{id}/logo-ai/jobs              recent runs for the task
    GET  /tasks/{id}/logo-ai/jobs/{job}        one run (progress polling)
    POST /tasks/{id}/logo-ai/jobs/{job}/cancel
    POST /tasks/{id}/logo-ai/filter/preview    what a score filter would remove
    POST /tasks/{id}/logo-ai/filter/apply      remove it
"""

from __future__ import annotations

import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation
from carve_api.annotations.schemas import AnnotationOut
from carve_api.assets.models import Asset, Frame
from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.logo_ai import catalog, providers
from carve_api.logo_ai import prompt as prompt_mod
from carve_api.logo_ai.detections import persist_detections
from carve_api.logo_ai.models import (
    DELIVERY_BATCH,
    DELIVERY_REALTIME,
    DELIVERY_SINGLE,
    PART_FAILED,
    PART_PENDING,
    PART_SUBMITTED,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_COMPLETED,
    STATUS_COMPLETED_WITH_ERRORS,
    STATUS_FAILED,
    STATUS_PREPARING,
    STATUS_QUEUED,
    TERMINAL_STATUSES,
    LogoAiBatchPart,
    LogoAiJob,
    LogoAiTaskPrompt,
)
from carve_api.logo_ai.providers.base import (
    LogoAiNotConfigured,
    ProviderFatal,
    RunContext,
    Usage,
)
from carve_api.logo_ai.service import (
    MAX_REFERENCES,
    AssetOutcome,
    LogoAiBadRequest,
    RunOptions,
    annotated_frame_ids,
    build_context,
    detect_image,
    estimate,
    first_frame,
    first_frames,
    read_image_bytes,
    scoped_assets,
)
from carve_api.permissions import require_logo_ai_task, task_logo_ai_allowed
from carve_api.projects.models import Task
from carve_api.projects.service import (
    _MUTATING_ROLES,
    require_project_role,
    require_visible_task,
)

log = logging.getLogger(__name__)

config_router = APIRouter(prefix="/inference/logo-ai", tags=["logo-ai"])
asset_router = APIRouter(prefix="/assets", tags=["logo-ai"])
task_router = APIRouter(prefix="/tasks", tags=["logo-ai"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(
        status_code=err.http_status,
        detail={"error": err.code, "message": err.message},
    )


def _redis_or_503() -> Redis:
    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        raise HTTPException(status_code=503, detail="redis_unavailable") from None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class ModelOut(BaseModel):
    id: str
    label: str
    blurb: str
    efforts: list[str]
    default_effort: str | None
    input_usd: float
    output_usd: float
    # False when the provider's batch API does not take the model.
    supports_batch: bool


class ProviderOut(BaseModel):
    id: str
    label: str
    configured: bool
    env_var: str
    supports_flex: bool
    default_model: str
    # What the second pass uses unless the run says otherwise; ``None``
    # means the run's own detection model and effort.
    default_check_model: str | None
    default_check_effort: str | None
    models: list[ModelOut]


class ConfigOut(BaseModel):
    # False when the caller may not use Logo AI on the given task.
    allowed: bool
    providers: list[ProviderOut]
    details: list[str]
    default_detail: str
    tilings: list[str]
    default_tiling: str
    max_references: int


@config_router.get("/config", response_model=ConfigOut)
def get_config(
    task_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ConfigOut:
    allowed = False
    if task_id is not None:
        try:
            task = require_visible_task(db, user, task_id)
            allowed = task_logo_ai_allowed(user, task)
        except AppError:
            allowed = False
    return ConfigOut(
        allowed=allowed,
        providers=[
            ProviderOut(
                id=p.id,
                label=p.label,
                configured=providers.is_configured(p.id),
                env_var=p.env_var,
                supports_flex=p.supports_flex,
                default_model=p.default_model,
                default_check_model=p.default_check_model,
                default_check_effort=p.default_check_effort,
                models=[
                    ModelOut(
                        id=m.id,
                        label=m.label,
                        blurb=m.blurb,
                        efforts=list(m.efforts),
                        default_effort=m.default_effort,
                        input_usd=m.input_usd,
                        output_usd=m.output_usd,
                        supports_batch=m.supports_batch,
                    )
                    for m in p.models
                ],
            )
            for p in catalog.PROVIDERS.values()
        ],
        details=list(catalog.DETAIL_MEGAPIXELS),
        default_detail=catalog.DEFAULT_DETAIL,
        tilings=list(catalog.TILING_MAX_PER_SIDE),
        default_tiling=catalog.DEFAULT_TILING,
        max_references=MAX_REFERENCES,
    )


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class PromptIn(BaseModel):
    """One class to detect, with what the model should look for."""

    class_id: uuid.UUID
    prompt: str = Field(default="", max_length=400)


class ReferenceIn(BaseModel):
    """An existing annotation used as a visual example of a class."""

    class_id: uuid.UUID
    asset_id: uuid.UUID
    bbox: list[float] = Field(..., min_length=4, max_length=4)


class RunIn(BaseModel):
    provider: str
    model: str
    effort: str | None = None
    prompts: list[PromptIn] = Field(..., min_length=1, max_length=100)
    references: list[ReferenceIn] = Field(default_factory=list, max_length=MAX_REFERENCES)
    detail: str = catalog.DEFAULT_DETAIL
    tiling: str = catalog.DEFAULT_TILING
    min_confidence: float = Field(default=0.3, ge=0.0, le=1.0)
    overwrite: bool = False
    # Keep a box only if at least this percentage of the logo is in
    # view (the model's estimate). 0 keeps every box.
    min_visible: int = Field(default=0, ge=0, le=100)
    # OpenAI only: near-realtime processing at the batch price.
    flex: bool = False
    # A second look at every box, enlarged, that drops the ones that
    # are not logos. Not available for batch runs.
    double_check: bool = False
    # The model and effort of the second pass; omitted = the provider's
    # tested default.
    check_model: str | None = None
    check_effort: str | None = None

    def options(self, **extra) -> RunOptions:  # noqa: ANN003
        return RunOptions(
            provider=self.provider,
            model=self.model,
            effort=self.effort,
            prompts=[
                {"class_id": str(p.class_id), "prompt": p.prompt.strip()}
                for p in self.prompts
            ],
            references=[
                {
                    "class_id": str(r.class_id),
                    "asset_id": str(r.asset_id),
                    "bbox": [float(v) for v in r.bbox],
                }
                for r in self.references
            ],
            detail=self.detail,
            tiling=self.tiling,
            min_confidence=self.min_confidence,
            overwrite=self.overwrite,
            min_visible=self.min_visible,
            flex=self.flex,
            double_check=self.double_check,
            check_model=self.check_model,
            check_effort=self.check_effort,
            **extra,
        )


class DetectIn(RunIn):
    frame_id: uuid.UUID | None = None


class TaskRunIn(RunIn):
    # Subset from the "Range" scope; omitted = every asset in the task.
    asset_ids: list[uuid.UUID] | None = None
    # Leave assets that already have annotations alone (and unbilled).
    skip_annotated: bool = False

    def options(self, **extra) -> RunOptions:  # noqa: ANN003
        return super().options(
            asset_ids=[str(a) for a in self.asset_ids] if self.asset_ids else None,
            skip_annotated=self.skip_annotated,
            **extra,
        )


class JobIn(TaskRunIn):
    delivery: str = Field(default=DELIVERY_REALTIME, pattern="^(realtime|batch)$")


# ---------------------------------------------------------------------------
# Single image
# ---------------------------------------------------------------------------


class DetectOut(BaseModel):
    annotations: list[AnnotationOut]
    annotations_created: int
    # Boxes the model returned that fell under ``min_confidence``.
    below_threshold: int
    # Boxes left out because too little of the logo was in view.
    mostly_hidden: int
    # Boxes the second pass looked at and rejected as not logos.
    rejected: int
    # Requests asked for as Flex that the provider served at the
    # standard price. Booked at the real price; should be zero.
    served_at_full_price: int
    overwrite_skipped: bool
    usage: dict[str, int]
    cost_usd: float


@asset_router.post("/{asset_id}/logo-ai/detect", response_model=DetectOut)
def detect_asset(
    asset_id: uuid.UUID,
    payload: DetectIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DetectOut:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    options = _with_task_prompt(db, asset.task_id, payload.options())
    try:
        task = require_logo_ai_task(db, user, asset.task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
        ctx = build_context(db, task, options)
        client = providers.make_client(ctx)
    except AppError as exc:
        raise _http(exc) from exc

    if payload.frame_id is not None:
        frame = db.get(Frame, payload.frame_id)
        if frame is None or frame.asset_id != asset.id:
            raise HTTPException(status_code=404, detail="frame_not_found")
    else:
        frame = first_frame(db, asset)
        if frame is None:
            raise HTTPException(status_code=409, detail="no_frames_extracted")

    image_bytes = read_image_bytes(asset, frame)
    started = datetime.now(UTC)
    try:
        # Tiles of one image go out together; the full frame goes first.
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcome = detect_image(client, ctx, options, image_bytes, pool=pool)
    except ProviderFatal as exc:
        _record_single(db, user, asset, ctx, options, started, error=exc.message)
        raise _http(exc) from exc
    if outcome.error:
        _record_single(
            db, user, asset, ctx, options, started, outcome=outcome, error=outcome.error
        )
        raise HTTPException(
            status_code=502,
            detail={"error": "logo_ai_failed", "message": outcome.error},
        )

    result = persist_detections(
        db,
        task_id=task.id,
        frame_id=frame.id,
        actor_id=user.id,
        class_ids=[uuid.UUID(c.class_id) for c in ctx.classes],
        dets=outcome.detections,
        min_confidence=options.min_confidence,
        min_visible=options.min_visible,
        overwrite=options.overwrite,
    )
    job = _record_single(
        db, user, asset, ctx, options, started,
        outcome=outcome, annotations=len(result.annotations),
    )
    return DetectOut(
        annotations=[AnnotationOut.from_orm_annotation(a) for a in result.annotations],
        annotations_created=len(result.annotations),
        below_threshold=sum(
            d.confidence < options.min_confidence for d in outcome.detections
        ),
        mostly_hidden=sum(
            d.confidence >= options.min_confidence and d.visible < options.min_visible
            for d in outcome.detections
        ),
        rejected=outcome.rejected,
        served_at_full_price=outcome.served_at_full_price if ctx.flex else 0,
        overwrite_skipped=result.overwrite_skipped,
        usage=outcome.usage.to_dict(),
        cost_usd=round(job.cost_usd, 6),
    )


def _record_single(
    db: Session,
    user: User,
    asset: Asset,
    ctx: RunContext,
    options: RunOptions,
    started: datetime,
    *,
    outcome: AssetOutcome | None = None,
    annotations: int = 0,
    error: str | None = None,
) -> LogoAiJob:
    """Put a single-image run on the books, already finished, and commit.

    It bills like any other run, so it belongs in the task's run history
    (and in what later estimates are averaged over) rather than only in
    a toast that is gone in six seconds.
    """
    usage = outcome.usage if outcome else Usage()
    job = LogoAiJob(
        task_id=asset.task_id,
        created_by=user.id,
        delivery=DELIVERY_SINGLE,
        provider=ctx.provider.id,
        model=ctx.model.id,
        effort=ctx.effort,
        params={**options.to_dict(), "asset_name": asset.original_name},
        status=STATUS_FAILED if error else STATUS_COMPLETED,
        total_assets=1,
        cursor=1,
        done_assets=1,
        failed_assets=1 if error else 0,
        annotations_created=annotations,
        rejected_boxes=outcome.rejected if outcome else 0,
        usage=usage.to_dict(),
        cost_usd=outcome.cost_usd if outcome else 0.0,
        errors=[],
        error=error,
        started_at=started,
        completed_at=datetime.now(UTC),
    )
    db.add(job)
    db.commit()
    return job


# ---------------------------------------------------------------------------
# Estimate
# ---------------------------------------------------------------------------


class EstimateOut(BaseModel):
    assets: int
    requests: int
    image_tokens: int
    prefix_tokens: int
    # Whether the shared prompt prefix is long enough for the provider
    # to cache it (and so bill re-reads at the cache rate).
    prefix_cached: bool
    min_cache_tokens: int
    output_tokens: int
    # Requests of this task's earlier runs (same model and effort) the
    # output figure is averaged over. 0 = built-in planning figure.
    based_on_requests: int
    cost_realtime_usd: float
    cost_flex_usd: float | None
    cost_batch_usd: float


def _assets_in_scope(db: Session, task: Task, options: RunOptions) -> list[Asset]:
    assets = scoped_assets(db, task.id, options.asset_ids)
    if not options.skip_annotated:
        return assets
    annotated = annotated_frame_ids(db, task.id)
    frames = first_frames(db, assets)
    return [
        a for a in assets if a.id in frames and frames[a.id].id not in annotated
    ]


@task_router.post("/{task_id}/logo-ai/estimate", response_model=EstimateOut)
def estimate_run(
    task_id: uuid.UUID,
    payload: TaskRunIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EstimateOut:
    options = _with_task_prompt(db, task_id, payload.options())
    try:
        task = require_logo_ai_task(db, user, task_id)
        figures = estimate(db, task, options, _assets_in_scope(db, task, options))
    except AppError as exc:
        raise _http(exc) from exc
    return EstimateOut(**figures)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


class JobOut(BaseModel):
    id: str
    task_id: str
    delivery: str
    provider: str
    model: str
    effort: str | None
    # The image's name, for a single-image run.
    label: str | None
    status: str
    # 0..1 across the whole run, whatever phase it is in.
    progress: float
    total_assets: int
    prepared_assets: int
    done_assets: int
    failed_assets: int
    skipped_assets: int
    annotations_created: int
    # Boxes the second pass dropped as not logos.
    rejected_boxes: int
    total_requests: int
    finished_requests: int
    usage: dict[str, int]
    cost_usd: float
    estimated_cost_usd: float | None
    errors: list[str]
    error: str | None
    # What an active run is waiting for, if anything, and when it tries
    # again by itself.
    notice: str | None
    resume_after: datetime | None
    created_at: datetime
    started_at: datetime | None
    submitted_at: datetime | None
    expires_at: datetime | None
    completed_at: datetime | None


def _progress(job: LogoAiJob) -> float:
    # A run that ended early keeps the bar where it stopped.
    if job.status in (STATUS_COMPLETED, STATUS_COMPLETED_WITH_ERRORS):
        return 1.0
    total = max(1, job.total_assets)
    if job.delivery != DELIVERY_BATCH:
        return min(1.0, job.done_assets / total)
    # Batch: 10% preparing, 60% provider, 30% writing results.
    if job.status in (STATUS_QUEUED, STATUS_PREPARING):
        return 0.1 * min(1.0, job.cursor / total)
    provider_share = job.finished_requests / max(1, job.total_requests)
    return min(1.0, 0.1 + 0.6 * provider_share + 0.3 * (job.done_assets / total))


def _job_out(job: LogoAiJob) -> JobOut:
    return JobOut(
        id=str(job.id),
        task_id=str(job.task_id),
        delivery=job.delivery,
        provider=job.provider,
        model=job.model,
        effort=job.effort,
        label=(job.params or {}).get("asset_name"),
        status=job.status,
        progress=round(_progress(job), 4),
        total_assets=job.total_assets,
        prepared_assets=job.cursor,
        done_assets=job.done_assets,
        failed_assets=job.failed_assets,
        skipped_assets=job.skipped_assets,
        annotations_created=job.annotations_created,
        rejected_boxes=job.rejected_boxes or 0,
        total_requests=job.total_requests,
        finished_requests=job.finished_requests,
        usage={k: int(v) for k, v in (job.usage or {}).items()},
        cost_usd=round(job.cost_usd or 0.0, 4),
        estimated_cost_usd=job.estimated_cost_usd,
        errors=[str(e) for e in (job.errors or [])],
        error=job.error,
        notice=job.notice,
        resume_after=job.resume_after,
        created_at=job.created_at,
        started_at=job.started_at,
        submitted_at=job.submitted_at,
        expires_at=job.expires_at,
        completed_at=job.completed_at,
    )


def _get_job(db: Session, task_id: uuid.UUID, job_id: uuid.UUID) -> LogoAiJob:
    job = db.get(LogoAiJob, job_id)
    if job is None or job.task_id != task_id:
        raise HTTPException(status_code=404, detail="job_not_found")
    return job


@task_router.post("/{task_id}/logo-ai/jobs", response_model=JobOut, status_code=201)
def create_job(
    task_id: uuid.UUID,
    payload: JobIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    from carve_api.logo_ai.jobs import (
        enqueue,
        run_logo_ai_batch_submit,
        run_logo_ai_realtime,
    )

    is_batch = payload.delivery == DELIVERY_BATCH
    # Flex is a realtime pricing tier; a batch is already at that price.
    options = _with_task_prompt(db, task_id, payload.options())
    if is_batch:
        options.flex = False
        # The second pass needs the boxes first, and a batch only hands
        # them over at the end.
        options.double_check = False
    try:
        task = require_logo_ai_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
        if not providers.is_configured(options.provider):
            raise LogoAiNotConfigured(f"{options.provider} has no API key configured")
        ctx = build_context(db, task, options)
        if is_batch and not ctx.model.supports_batch:
            raise LogoAiBadRequest(
                f"{ctx.model.label} is not available through {ctx.provider.label}'s "
                "batch API. Pick another model for Batch, or use Realtime (Flex)."
            )
        assets = _assets_in_scope(db, task, options)
        figures = estimate(db, task, options, assets)
    except AppError as exc:
        raise _http(exc) from exc
    if not assets:
        raise HTTPException(
            status_code=422,
            detail={"error": "logo_ai_bad_request", "message": "no assets to process"},
        )

    # One run per task at a time: a double-click would otherwise pay for
    # every image twice and write every box twice.
    active = db.execute(
        select(LogoAiJob.id).where(
            LogoAiJob.task_id == task_id,
            LogoAiJob.status.not_in(TERMINAL_STATUSES),
        )
    ).first()
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "logo_ai_job_active",
                "message": "A Logo AI run is already in progress for this task.",
            },
        )

    if is_batch:
        estimated = figures["cost_batch_usd"]
    elif ctx.flex:
        estimated = figures["cost_flex_usd"]
    else:
        estimated = figures["cost_realtime_usd"]
    job = LogoAiJob(
        task_id=task_id,
        created_by=user.id,
        delivery=payload.delivery,
        provider=ctx.provider.id,
        model=ctx.model.id,
        effort=ctx.effort,
        params=options.to_dict(),
        status=STATUS_QUEUED,
        total_assets=len(assets),
        estimated_cost_usd=estimated,
        usage={},
        errors=[],
    )
    db.add(job)
    db.commit()

    try:
        enqueue(
            run_logo_ai_batch_submit if is_batch else run_logo_ai_realtime,
            str(job.id),
            connection=_redis_or_503(),
        )
    except Exception as exc:
        # Never leave a row that claims to be queued with nothing behind it.
        db.delete(job)
        db.commit()
        if isinstance(exc, HTTPException):
            raise
        log.exception("logo_ai: enqueue failed")
        raise HTTPException(status_code=503, detail="enqueue_failed") from exc
    return _job_out(job)


@task_router.get("/{task_id}/logo-ai/jobs", response_model=list[JobOut])
def list_jobs(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[JobOut]:
    try:
        require_logo_ai_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    jobs = db.execute(
        select(LogoAiJob)
        .where(LogoAiJob.task_id == task_id)
        .order_by(LogoAiJob.created_at.desc())
        .limit(20)
    ).scalars()
    return [_job_out(j) for j in jobs]


@task_router.get("/{task_id}/logo-ai/jobs/{job_id}", response_model=JobOut)
def get_job(
    task_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    try:
        require_logo_ai_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return _job_out(_get_job(db, task_id, job_id))


def _abandon_batch(db: Session, job: LogoAiJob) -> LogoAiJob:
    """Close a canceling batch without waiting for the provider.

    The way out when the provider cannot be reached or a part cannot be
    read, which would otherwise hold the task's one run slot until the
    results age out. Whatever was not collected yet is given up: it
    stays billed, and is not written.
    """
    # Waits for a poll that is writing a part right now, so the counters
    # below start from what it committed.
    job = db.execute(
        select(LogoAiJob)
        .where(LogoAiJob.id == job.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    if job.status in TERMINAL_STATUSES:
        db.commit()
        return job
    parts = db.execute(
        select(LogoAiBatchPart).where(
            LogoAiBatchPart.job_id == job.id,
            LogoAiBatchPart.status.in_([PART_SUBMITTED, PART_PENDING]),
        )
    ).scalars()
    for part in parts:
        n = len(part.meta.get("assets", []))
        part.status = PART_FAILED
        part.ended = True
        part.error = "abandoned: the run was force-stopped"
        job.done_assets += n
        job.failed_assets += n
    job.status = STATUS_CANCELED
    job.completed_at = datetime.now(UTC)
    job.notice = None
    job.resume_after = None
    db.commit()
    return job


@task_router.post("/{task_id}/logo-ai/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(
    task_id: uuid.UUID,
    job_id: uuid.UUID,
    force: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobOut:
    from carve_api.jobs.queue import try_cancel_rq_job
    from carve_api.logo_ai.jobs import enqueue_poll

    try:
        require_logo_ai_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    job = _get_job(db, task_id, job_id)
    # A stale click must not overwrite a real outcome.
    if job.status in TERMINAL_STATUSES:
        return _job_out(job)
    if job.status == STATUS_CANCELING and job.delivery == DELIVERY_BATCH:
        if not force:
            # Already waiting on the provider; the poller finishes it.
            return _job_out(job)
        return _job_out(_abandon_batch(db, job))

    if job.status in (STATUS_QUEUED, STATUS_CANCELING):
        # Not started yet — or a realtime run asked to stop a second
        # time, which means its worker never acknowledged the first
        # (it died, or is not running). Close it out directly so it
        # cannot block the task's next run.
        job.status = STATUS_CANCELED
        job.completed_at = datetime.now(UTC)
        db.commit()
        try:
            try_cancel_rq_job(_redis_or_503(), str(job.id))
        except HTTPException:
            pass
        return _job_out(job)

    # Running: the worker stops at its next checkpoint and keeps what is
    # already written. A batch also waits for the provider to stop, then
    # ingests the results it had already produced (they are billed).
    job.status = STATUS_CANCELING
    # A run that was waiting to try again has nothing left to wait for.
    job.notice = None
    job.resume_after = None
    db.commit()
    if job.delivery == DELIVERY_BATCH:
        try:
            enqueue_poll(str(job.id), connection=_redis_or_503())
        except Exception:  # noqa: BLE001 — the poller thread will pick it up
            log.warning("logo_ai: could not queue cancel poll", exc_info=True)
    return _job_out(job)


# ---------------------------------------------------------------------------
# The task's own instructions
# ---------------------------------------------------------------------------

# Far more than a thorough rubric needs; the point is a bound.
_PROMPT_MAX_CHARS = 40_000
# A prompt prefix shorter than this is not cached by OpenAI (1,024
# tokens, at about four characters per token), so every request of a
# run pays for it in full.
_PROMPT_CACHE_MIN_CHARS = 4_400


def _with_task_prompt(db: Session, task_id: uuid.UUID, options: RunOptions) -> RunOptions:
    """Give a run the task's own instructions, if it has any."""
    row = db.get(LogoAiTaskPrompt, task_id)
    if row is not None:
        options.instructions = row.instructions
        options.check_instructions = row.check_instructions
    return options


class TaskPromptOut(BaseModel):
    # The text in force: the task's own, or the default.
    instructions: str
    check_instructions: str
    # Whether each is the task's own.
    custom: bool
    check_custom: bool
    default_instructions: str
    default_check_instructions: str
    # What is added after the instructions on every request, shown for
    # reference; it cannot be edited.
    format_preview: str
    check_format_preview: str
    max_chars: int
    cache_min_chars: int
    updated_at: datetime | None


class TaskPromptIn(BaseModel):
    # ``None`` or blank: go back to the default text.
    instructions: str | None = Field(default=None, max_length=_PROMPT_MAX_CHARS)
    check_instructions: str | None = Field(default=None, max_length=_PROMPT_MAX_CHARS)


def _prompt_out(row: LogoAiTaskPrompt | None, coords: str) -> TaskPromptOut:
    own = row.instructions if row else None
    own_check = row.check_instructions if row else None
    return TaskPromptOut(
        instructions=own or prompt_mod.DEFAULT_INSTRUCTIONS,
        check_instructions=own_check or prompt_mod.DEFAULT_CHECK_INSTRUCTIONS,
        custom=bool(own),
        check_custom=bool(own_check),
        default_instructions=prompt_mod.DEFAULT_INSTRUCTIONS,
        default_check_instructions=prompt_mod.DEFAULT_CHECK_INSTRUCTIONS,
        format_preview=prompt_mod.format_preview(coords),
        check_format_preview=prompt_mod.check_format_preview(),
        max_chars=_PROMPT_MAX_CHARS,
        cache_min_chars=_PROMPT_CACHE_MIN_CHARS,
        updated_at=row.updated_at if row else None,
    )


def _coords_for(provider: str | None, model: str | None) -> str:
    """The coordinate system of the model the dialog has selected, for
    the preview; the default provider's if it is not given or unknown."""
    try:
        spec = catalog.get_provider(provider or catalog.OPENAI)
        chosen = catalog.get_model(spec.id, model or spec.default_model)
    except ValueError:
        spec = catalog.get_provider(catalog.OPENAI)
        chosen = catalog.get_model(spec.id, spec.default_model)
    return chosen.coords or spec.coords


def _own_text(text: str | None, default: str) -> str | None:
    """What to store: nothing for a blank text or one equal to the
    default, so that a later change of the default reaches the task."""
    cleaned = (text or "").strip()
    return None if not cleaned or cleaned == default.strip() else cleaned


@task_router.get("/{task_id}/logo-ai/prompt", response_model=TaskPromptOut)
def get_prompt(
    task_id: uuid.UUID,
    provider: str | None = None,
    model: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskPromptOut:
    try:
        require_logo_ai_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return _prompt_out(db.get(LogoAiTaskPrompt, task_id), _coords_for(provider, model))


@task_router.put("/{task_id}/logo-ai/prompt", response_model=TaskPromptOut)
def put_prompt(
    task_id: uuid.UUID,
    payload: TaskPromptIn,
    provider: str | None = None,
    model: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskPromptOut:
    try:
        task = require_logo_ai_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    own = _own_text(payload.instructions, prompt_mod.DEFAULT_INSTRUCTIONS)
    own_check = _own_text(payload.check_instructions, prompt_mod.DEFAULT_CHECK_INSTRUCTIONS)
    row = db.get(LogoAiTaskPrompt, task_id)
    if row is None:
        row = LogoAiTaskPrompt(task_id=task_id)
        db.add(row)
    row.instructions = own
    row.check_instructions = own_check
    row.updated_by = user.id
    row.updated_at = datetime.now(UTC)
    db.commit()
    return _prompt_out(row, _coords_for(provider, model))


# ---------------------------------------------------------------------------
# Score filter
# ---------------------------------------------------------------------------


class FilterIn(BaseModel):
    """Thresholds for boxes a model scored. A box goes when it is under
    either one."""

    min_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    min_visible: int = Field(default=0, ge=0, le=100)
    # Limit to these assets (the open image, or a range); omitted = the
    # whole task.
    asset_ids: list[uuid.UUID] | None = None


class FilterOut(BaseModel):
    # Boxes in scope that carry model scores and may be filtered.
    scored: int
    # Of those, how many are under a threshold.
    below: int
    # Images that have at least one such box.
    assets: int
    # True when the boxes were deleted rather than only counted.
    applied: bool


def _filterable(task_id: uuid.UUID, payload: FilterIn):
    """Conditions selecting the boxes a score filter may touch.

    Only boxes that still carry the model's scores: anything a person
    drew or edited has none. Accepted boxes are left alone too — a
    reviewer has signed them off.
    """
    conditions = [
        Annotation.task_id == task_id,
        Annotation.confidence.is_not(None),
        Annotation.status != "accepted",
    ]
    if payload.asset_ids is not None:
        conditions.append(
            Annotation.frame_id.in_(
                select(Frame.id).where(Frame.asset_id.in_(payload.asset_ids))
            )
        )
    return conditions


def _below(payload: FilterIn):
    # The epsilon keeps a box scored exactly at the threshold: 0.8 must
    # survive "at least 0.8" whatever float the slider produced.
    return or_(
        Annotation.confidence < payload.min_confidence - 1e-9,
        func.coalesce(Annotation.visible, 100) < payload.min_visible,
    )


def _filter_counts(db: Session, task_id: uuid.UUID, payload: FilterIn) -> tuple[int, int, int]:
    scope = _filterable(task_id, payload)
    scored = db.execute(select(func.count()).select_from(Annotation).where(*scope)).scalar_one()
    below, assets = db.execute(
        select(func.count(), func.count(func.distinct(Annotation.frame_id))).where(
            *scope, _below(payload)
        )
    ).one()
    return int(scored), int(below), int(assets)


@task_router.post("/{task_id}/logo-ai/filter/preview", response_model=FilterOut)
def preview_filter(
    task_id: uuid.UUID,
    payload: FilterIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FilterOut:
    try:
        require_logo_ai_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    scored, below, assets = _filter_counts(db, task_id, payload)
    return FilterOut(scored=scored, below=below, assets=assets, applied=False)


@task_router.post("/{task_id}/logo-ai/filter/apply", response_model=FilterOut)
def apply_filter(
    task_id: uuid.UUID,
    payload: FilterIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FilterOut:
    """Delete the scored boxes under the thresholds. Not reversible:
    getting them back takes a new run."""
    try:
        task = require_logo_ai_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    scored, below, assets = _filter_counts(db, task_id, payload)
    if below:
        db.execute(
            sa_delete(Annotation)
            .where(*_filterable(task_id, payload), _below(payload))
            .execution_options(synchronize_session=False)
        )
        db.commit()
    return FilterOut(scored=scored, below=below, assets=assets, applied=True)

