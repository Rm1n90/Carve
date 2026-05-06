# Armin Mehri — mehri.armin@gmail.com
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.schemas import AnnotationOut
from carve_api.assets.models import Asset
from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.inference.autoannotate import (
    auto_annotate_asset,
    fetch_asset_bytes,
    presigned_url_for_weight,
)
from carve_api.inference.batch import (
    build_auto_text_payload,
    build_job_payload,
    read_progress,
    run_auto_text_batch,
    run_batch_auto_annotate,
)
from carve_api.inference.auto_text import (
    AutoTextNoEligibleClasses,
    auto_text_for_asset,
)
from carve_api.inference.sam import (
    sam_box_prompt_for_asset,
    sam_decode_with_hash,
    sam_encode_for_asset,
    sam_text_prompt_for_asset,
)
from carve_api.inference.sam_track import (
    add_object as _track_add_object,
    release as _track_release,
    remove_object as _track_remove_object,
    reset_session as _track_reset_session,
    start as _track_start,
    step as _track_step,
)
from carve_api.projects.service import (
    _MUTATING_ROLES,
    require_project_role,
    require_visible_task,
)
from carve_api.weights.models import Weight, WeightAssignment


router = APIRouter(prefix="/assets", tags=["auto-annotate"])
task_inference_router = APIRouter(prefix="/tasks", tags=["auto-annotate"])
# v3.23 — YOLOE capability probe + (future) any non-asset/task scoped
# endpoints. Mounted alongside the other two via main.py.
inference_yoloe_router = APIRouter(prefix="/inference", tags=["yoloe"])


def _redis_client_or_none() -> Redis | None:
    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        # cheap probe — if Redis isn't up, ping() raises immediately
        client.ping()
        return client
    except Exception:
        return None


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


class AutoAnnotateResponse(BaseModel):
    """v3.3 Issue 3c — predict response now includes a skipped-by-class
    summary so the editor can surface "Created N · skipped M (unmapped: …)"
    instead of silently dropping unmapped detections.

    v3.7.2 — adds ``overwrite_skipped`` so the UI can warn when the user
    requested overwrite=true but the existing annotations were
    intentionally preserved (because the new prediction yielded zero
    annotations). Defaults to ``False`` for backward compatibility.
    """

    annotations: list[AnnotationOut]
    annotations_created: int
    skipped_count: int
    skipped_by_class: dict[str, int]
    overwrite_skipped: bool = False


class AutoAnnotateBody(BaseModel):
    """Optional JSON body for ``POST /assets/{aid}/auto-annotate``.

    v3.5 Phase F2 — ``class_overrides`` is a per-weight-class binding
    decided at predict time (sent from the predict popover). Keys are
    weight-class indices (string-encoded for JSON safety; values are
    project-class ids). A value of ``None`` means "skip this weight class
    for this predict run". When the overrides map is empty/omitted, the
    autoannotate pipeline falls back to case-insensitive name-match
    against the project's classes.
    """

    class_overrides: dict[str, str | None] | None = Field(default=None)


@router.post("/{asset_id}/auto-annotate", response_model=AutoAnnotateResponse)
def auto_annotate(
    asset_id: uuid.UUID,
    weight_id: uuid.UUID | None = None,
    overwrite: bool = False,
    min_confidence: float = 0.0,
    # v3.7.5 — IOU threshold (NMS) is now a per-call dial. Default mirrors
    # the Ultralytics default. Pydantic/FastAPI clamps via the Query validator.
    iou: float = Query(0.7, ge=0.0, le=1.0),
    body: AutoAnnotateBody | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoAnnotateResponse:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, asset.task_id)
        # Plan-13 Phase 7 Task 2 — auto-annotate is a mutation; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    # v3.5 Phase F5 — `weight_id` is now optional. When omitted, fall
    # back to the project's default for any task_kind by joining
    # ``weight_project_defaults``. Workspace-wide weights are eligible.
    if weight_id is None:
        from carve_api.weights.models import WeightProjectDefault

        weight = db.execute(
            select(Weight)
            .join(
                WeightProjectDefault,
                WeightProjectDefault.weight_id == Weight.id,
            )
            .where(WeightProjectDefault.project_id == task.project_id)
            .order_by(Weight.created_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if weight is None:
            raise HTTPException(status_code=400, detail="no_default_weight")
    else:
        weight = db.get(Weight, weight_id)
        if weight is None:
            raise HTTPException(status_code=404, detail="weight_not_found")
    # Clamp incoming `min_confidence` so a misbehaving client can't bypass
    # the bounds. The slider in the UI is 0..1; anything else is a bug.
    min_confidence = max(0.0, min(1.0, float(min_confidence)))
    # v3.5 Phase F2 — coerce the wire ``{"3": "<uuid>"}`` map into
    # ``{int: UUID | None}`` for the autoannotate pipeline. Invalid keys /
    # values are dropped silently; the user can re-pick from the popover.
    overrides: dict[int, uuid.UUID | None] | None = None
    if body is not None and body.class_overrides is not None:
        overrides = {}
        for k, v in body.class_overrides.items():
            try:
                idx = int(k)
            except (TypeError, ValueError):
                continue
            if v is None:
                overrides[idx] = None
                continue
            try:
                overrides[idx] = uuid.UUID(str(v))
            except (TypeError, ValueError):
                # Bad uuid — treat as "no override for this idx" rather than
                # 422-ing the whole call; the predict popover guarantees uuids.
                continue
    try:
        image_bytes = fetch_asset_bytes(asset)
        url = presigned_url_for_weight(weight)
        result = auto_annotate_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            weight=weight,
            overwrite=overwrite,
            presigned_url_for_weight=url,
            image_bytes=image_bytes,
            min_confidence=min_confidence,
            iou=iou,
            class_overrides=overrides,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return AutoAnnotateResponse(
        annotations=[AnnotationOut.from_orm_annotation(a) for a in result.annotations],
        annotations_created=result.annotations_created,
        skipped_count=result.skipped_count,
        skipped_by_class=dict(result.skipped_by_class),
        overwrite_skipped=bool(result.overwrite_skipped),
    )


class BatchAutoAnnotateBody(BaseModel):
    """v3.7 Phase 2 Issue 1 — optional JSON body for the batch enqueue
    endpoint. Mirrors :class:`AutoAnnotateBody` so the same predict
    popover state (min_confidence + class_overrides) maps cleanly to
    both the single-asset and the all-assets-in-task call sites.

    Both fields are optional; an empty body keeps the legacy
    "name-match + zero confidence floor" defaults.

    v3.7.5 — adds optional ``iou`` (NMS threshold) so the batch path
    matches the single-asset path. ``None`` means "use the autoannotate
    default (0.7)".
    """

    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    iou: float | None = Field(default=None, ge=0.0, le=1.0)
    class_overrides: dict[str, str | None] | None = Field(default=None)


@task_inference_router.post("/{task_id}/auto-annotate")
def enqueue_batch_auto_annotate(
    task_id: uuid.UUID,
    weight_id: uuid.UUID,
    overwrite: bool = False,
    body: BatchAutoAnnotateBody | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
        # Plan-13 Phase 7 Task 2 — batch auto-annotate is a mutation; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    # v3.5 Phase F5 — workspace-wide weights (project_id IS NULL) are
    # valid for any task; project-scoped weights still must match.
    # v3.7 Phase 3 Issue 4 — also accept weights joined via
    # ``weight_assignments`` so a project-scoped or workspace weight
    # explicitly assigned to this project's id is allowed.
    if weight.project_id is not None and weight.project_id != task.project_id:
        is_assigned = (
            db.execute(
                select(WeightAssignment).where(
                    WeightAssignment.weight_id == weight.id,
                    WeightAssignment.project_id == task.project_id,
                )
            ).scalar_one_or_none()
            is not None
        )
        if not is_assigned:
            raise HTTPException(status_code=400, detail="weight_project_mismatch")

    # v3.7 Phase 2 Issue 1 — coerce the wire ``{"3": "<uuid>"}`` body
    # into ``{int: str | None}`` for the RQ payload. Same validation
    # shape as :func:`auto_annotate` in the single-asset path: invalid
    # keys / values are dropped silently rather than 422-ing the call.
    overrides_for_payload: dict[int, str | None] | None = None
    min_conf: float | None = None
    iou_value: float | None = None
    if body is not None:
        if body.min_confidence is not None:
            # Pydantic already enforced 0..1 via Field(ge=0, le=1).
            min_conf = float(body.min_confidence)
        if body.iou is not None:
            # v3.7.5 — Pydantic enforces 0..1 above; coerce for the
            # RQ payload so a stray int slips through cleanly.
            iou_value = float(body.iou)
        if body.class_overrides is not None:
            overrides_for_payload = {}
            for k, v in body.class_overrides.items():
                try:
                    idx = int(k)
                except (TypeError, ValueError):
                    continue
                if v is None:
                    overrides_for_payload[idx] = None
                    continue
                # Validate UUID shape but keep the raw string in the
                # payload so RQ pickles cleanly across worker boundaries.
                try:
                    uuid.UUID(str(v))
                except (TypeError, ValueError):
                    continue
                overrides_for_payload[idx] = str(v)

    payload = build_job_payload(
        actor=user,
        task=task,
        weight=weight,
        overwrite=overwrite,
        min_confidence=min_conf,
        iou=iou_value,
        class_overrides=overrides_for_payload,
    )

    # Best-effort enqueue — if Redis/RQ are not reachable, return the job_id anyway
    # so callers can poll later when Redis is back up. Production has Redis up by
    # docker-compose health gates.
    try:
        from rq import Queue

        from carve_api.jobs.queue import enqueue_with_defaults

        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            # plan-09 task-09 — predict batches can run long; bump
            # job_timeout to 2h so RQ doesn't reap the worker mid-batch.
            # v3.22 — pin RQ's job_id to our progress key so the cancel
            # endpoint can ``send_stop_job_command`` and free the
            # single-worker queue immediately, instead of waiting for
            # the in-flight asset's HTTP call to the model service to
            # return at the next per-asset cancel checkpoint.
            enqueue_with_defaults(
                q,
                run_batch_auto_annotate,
                payload,
                job_id=payload.job_id,
                job_timeout=2 * 3600,
            )
    except Exception:
        pass
    return {"job_id": payload.job_id}


class BatchAutoAnnotateProgress(BaseModel):
    """v3.7.2 — Pydantic schema for the batch progress polling endpoint.

    Mirrors the Redis hash written by ``run_batch_auto_annotate`` and
    extends the legacy shape ({status, done, total, failed, errors})
    with ``total_annotations_created`` and ``total_skipped_detections``
    so the frontend can show a clear post-batch toast such as
    "Created N annotations across M of K assets. Skipped Q detections."

    v3.7.4 — adds ``skipped_by_class`` so the toast can name the most
    common unmapped weight classes (e.g. "person (412), boat (305)")
    instead of just an opaque count. Empty dict when the batch path
    was never run or the worker emitted no skips.
    """

    status: str = "pending"
    done: int = 0
    total: int = 0
    failed: int = 0
    errors: list[str] = Field(default_factory=list)
    total_annotations_created: int = 0
    total_skipped_detections: int = 0
    skipped_by_class: dict[str, int] = Field(default_factory=dict)


@task_inference_router.get(
    "/{task_id}/auto-annotate/{job_id}",
    response_model=BatchAutoAnnotateProgress,
)
def get_batch_progress(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return read_progress(_redis_client_or_none(), job_id)


# v3.8 Phase 3.5 — multi-asset SAM 3 text-prompt batch.
class SamAutoTextBatchIn(BaseModel):
    class_ids: list[uuid.UUID] = Field(..., min_length=1)
    threshold: float = Field(default=0.4, ge=0.0, le=1.0)
    find_all: bool = Field(default=True)
    overwrite: bool = Field(default=False)
    # v3.21+ — VLM-FO1 precision filter opt-in for the multi-asset Auto
    # mode batch. Persists into AutoTextBatchPayload so each per-asset
    # iteration in the worker honors the same toggle.
    use_vlm_fo1: bool = Field(default=False)


@task_inference_router.post("/{task_id}/sam/auto-text-batch")
def enqueue_sam_auto_text_batch(
    task_id: uuid.UUID,
    payload: SamAutoTextBatchIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Enqueue a multi-asset SAM 3 text-prompt batch. Reuses the same
    Redis progress hash as YOLO batches so the frontend's polling
    dialog (BatchProgressDialog) works for both engines.
    """
    try:
        task = require_visible_task(db, user, task_id)
        # Plan-13 Phase 7 Task 2 — SAM auto-text batch is a mutation; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    from carve_api.projects.models import Class as ClassModel

    classes = (
        db.query(ClassModel)
        .filter(
            ClassModel.id.in_(payload.class_ids),
            ClassModel.project_id == task.project_id,
        )
        .all()
    )
    if not classes:
        raise HTTPException(status_code=422, detail="no_matching_classes")
    eligible = [c for c in classes if (c.text_prompt or "").strip()]
    if not eligible:
        raise HTTPException(status_code=422, detail="no_eligible_classes")

    job_payload = build_auto_text_payload(
        actor=user,
        task=task,
        class_ids=[c.id for c in eligible],
        threshold=payload.threshold,
        find_all=payload.find_all,
        overwrite=payload.overwrite,
        use_vlm_fo1=payload.use_vlm_fo1,
    )
    try:
        from rq import Queue
        from carve_api.jobs.queue import enqueue_with_defaults
        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            # v3.22 — pin RQ's job_id (see YOLO enqueue above) so cancel
            # can ``send_stop_job_command`` and free the worker.
            enqueue_with_defaults(
                q,
                run_auto_text_batch,
                job_payload,
                job_id=job_payload.job_id,
            )
    except Exception:
        pass
    return {"job_id": job_payload.job_id}


@task_inference_router.get(
    "/{task_id}/sam/auto-text-batch/{job_id}",
    response_model=BatchAutoAnnotateProgress,
)
def get_sam_auto_text_batch_progress(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return read_progress(_redis_client_or_none(), job_id)


# v3.22 — co-operative cancel for the YOLO auto-annotate batch.
# Mirrors the SAM auto-text-batch cancel: the worker checks the Redis
# hash's ``status`` between assets; setting it to ``canceled`` breaks
# the loop after the in-flight asset commits. Already-saved
# annotations are kept (per-asset commit pattern).
@task_inference_router.post(
    "/{task_id}/auto-annotate/{job_id}/cancel",
    status_code=202,
)
def cancel_auto_annotate_batch(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis_client_or_none()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    try:
        from carve_api.inference.batch import progress_key
        client.hset(progress_key(job_id), "status", "canceled")
    except Exception:
        raise HTTPException(status_code=502, detail="cancel_failed") from None
    # v3.22.1 — also send the SIGRTMIN-based stop command so the worker
    # exits the in-flight asset's HTTP call to the model service
    # immediately rather than waiting at the next per-asset checkpoint.
    # Without this, a follow-up Predict click sits in the RQ queue for
    # the remainder of the in-flight asset (often 10-30s) before the
    # single worker is free to pick up the new job.
    _try_send_stop(client, job_id)
    return {"job_id": job_id, "status": "canceled"}


# v3.8 Phase 3.5 — co-operative cancellation. The worker reads the
# Redis hash's ``status`` between assets; setting it to ``canceled``
# breaks the loop after the in-flight asset commits. Already-saved
# annotations are kept (per-asset commit pattern).
@task_inference_router.post(
    "/{task_id}/sam/auto-text-batch/{job_id}/cancel",
    status_code=202,
)
def cancel_sam_auto_text_batch(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis_client_or_none()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    try:
        from carve_api.inference.batch import progress_key
        client.hset(progress_key(job_id), "status", "canceled")
    except Exception:
        raise HTTPException(status_code=502, detail="cancel_failed") from None
    _try_send_stop(client, job_id)
    return {"job_id": job_id, "status": "canceled"}


def _try_send_stop(client, rq_job_id: str) -> None:
    """v3.22.1 — best-effort ``rq.command.send_stop_job_command``.

    The cooperative Redis flag is the source of truth for "this batch
    was canceled — keep already-committed annotations". The stop
    command is purely a latency optimization: it interrupts the
    worker's in-flight HTTP call to the model service so a follow-up
    Predict can start immediately on the same single worker.

    Tolerates: missing job (already finished), worker not listening,
    older RQ versions without ``send_stop_job_command``.
    """
    try:
        from rq.command import send_stop_job_command  # type: ignore
        send_stop_job_command(client, rq_job_id)
    except Exception:  # noqa: BLE001
        # Job may have already finished, or the worker isn't running
        # this job_id, or the RQ version doesn't expose the command.
        # The Redis ``canceled`` flag still wins at the next checkpoint.
        pass


class SamDecodeIn(BaseModel):
    image_hash: str
    # v3.8 Phase 2 — points/labels are now optional so the editor's
    # BBox mode can issue a box-only decode (and refine with clicks via
    # subsequent decodes that pass both). The model service validates
    # at least one of (points, box) is present.
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    # v3.8 Phase 2 — optional xyxy box. Combines with points at decode
    # time so a box-then-click refinement loop reuses the embedding
    # cache (no SAM 3-only /sam/box-prompt round-trip).
    box: list[float] | None = None
    # v3.22 — Douglas-Peucker tolerance for the returned polygon. The
    # editor's "Polygon approximation points" slider sends this; the
    # frontend converts its 0-100 range to a useful epsilon range.
    # ``None`` lets the model service pick a default.
    epsilon_factor: float | None = Field(default=None, gt=0.0, le=0.1)


class SamTextIn(BaseModel):
    """Body for POST /assets/{id}/sam/text-prompt — SAM 3 only.

    A single positive text concept describing the object (e.g. "person").
    Matches the model service's TextPromptIn — see
    ``apps/model/src/carve_model/sam/router.py``.

    v3.8 Phase 4-video step F4 — ``frame_id`` selects a per-frame JPEG
    when the asset is a video; omit (or null) for image assets.
    """

    text: str = Field(..., min_length=1, max_length=200)
    frame_id: uuid.UUID | None = None
    # v3.21+ — opt-in VLM-FO1 precision filter (server-side gating via
    # /sam/status.vlm_fo1_available; default False preserves existing
    # behaviour).
    use_vlm_fo1: bool = False


class SamBoxIn(BaseModel):
    """Body for POST /assets/{id}/sam/box-prompt — SAM 3 only.

    ``boxes`` are xyxy floats; ``box_labels`` are 1 (positive include)
    or 0 (negative exclude). ``text`` optionally combines a concept
    with the boxes for refinement (e.g. text + a negative box that
    crops out a sibling instance). Mirrors the model service's
    BoxPromptIn.
    """

    boxes: list[list[float]] = Field(..., min_length=1)
    box_labels: list[int] = Field(..., min_length=1)
    text: str | None = Field(default=None, max_length=200)
    # v3.8 Phase 4-video step F4 -- per-frame JPEG selector.
    frame_id: uuid.UUID | None = None


# v3.8 Phase 3.5 — multi-class SAM 3 text-prompt auto-annotate (sync,
# single asset). The dialog UI builds the body from a class checklist;
# only classes whose ``text_prompt`` is non-empty are sent.
class SamAutoTextIn(BaseModel):
    class_ids: list[uuid.UUID] = Field(..., min_length=1)
    threshold: float = Field(default=0.4, ge=0.0, le=1.0)
    find_all: bool = Field(default=True)
    overwrite: bool = Field(default=False)
    # v3.21+ — VLM-FO1 precision filter opt-in for the Auto-mode dialog.
    # The flag fans out to every class iteration inside auto_text_for_asset.
    use_vlm_fo1: bool = Field(default=False)


class SamAutoTextOut(BaseModel):
    annotations_created: int
    per_class: dict[str, int]
    ineligible: list[str]


@router.post(
    "/{asset_id}/sam/auto-text",
    response_model=SamAutoTextOut,
)
def sam_auto_text_endpoint(
    asset_id: uuid.UUID,
    payload: SamAutoTextIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SamAutoTextOut:
    """Run SAM 3 text-prompt for each selected class on this asset.

    For each class with a stored ``text_prompt``, calls /sam/text-prompt
    once and saves polygon (preferred) / mask (fallback) annotations
    above ``threshold``. ``find_all=False`` keeps only the highest-
    scored result per class. ``overwrite=True`` deletes existing
    annotations of the selected classes on this asset's frame BEFORE
    inserting new ones (and only when at least one new annotation is
    going to land -- v3.7.2 zero-match safety).
    """
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, asset.task_id)
        # Plan-13 Phase 7 Task 2 — sync SAM auto-text mutates annotations; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    # Resolve classes from the task's project, preserving the user's
    # request order. Skip ids that don't belong to the project.
    from carve_api.projects.models import Class

    classes = (
        db.query(Class)
        .filter(Class.id.in_(payload.class_ids), Class.project_id == task.project_id)
        .all()
    )
    if not classes:
        raise HTTPException(status_code=422, detail="no_matching_classes")
    try:
        result = auto_text_for_asset(
            session=db,
            asset=asset,
            task=task,
            classes=classes,
            threshold=payload.threshold,
            find_all=payload.find_all,
            overwrite=payload.overwrite,
            actor_id=user.id,
            use_vlm_fo1=payload.use_vlm_fo1,
        )
    except AutoTextNoEligibleClasses as exc:
        raise _http(exc) from exc
    except AppError as exc:
        # SAM upstream errors (Sam3NotEnabled, SamModelUnreachable,
        # SamModelFailed) get the standard envelope.
        raise _http(exc) from exc
    db.commit()
    # v3.22 — drop the FO1 sidecar's GPU weights when the user opted
    # into FO1 for this single-asset run. Best-effort; never raises.
    if payload.use_vlm_fo1:
        try:
            from carve_api.inference.model_client import sam_vlm_fo1_unload
            sam_vlm_fo1_unload()
        except Exception:  # noqa: BLE001
            pass
    return SamAutoTextOut(**result)


@router.post("/{asset_id}/sam/encode")
def sam_encode_endpoint(
    asset_id: uuid.UUID,
    frame_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return sam_encode_for_asset(asset, frame_id=frame_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam/decode")
def sam_decode_endpoint(
    asset_id: uuid.UUID,
    payload: SamDecodeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return sam_decode_with_hash(
            payload.image_hash,
            payload.points,
            payload.labels,
            box=payload.box,
            epsilon_factor=payload.epsilon_factor,
        )
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam/text-prompt")
def sam_text_prompt_endpoint(
    asset_id: uuid.UUID,
    payload: SamTextIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """SAM 3 text concept prompt — returns mask candidates for ``text``.

    Returns 409 ``sam3_not_enabled`` when the active SAM variant is not
    SAM 3, 503 ``model_service_unreachable`` when the model service is
    down, and 502 ``sam_model_failed`` for other upstream errors.
    """
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return sam_text_prompt_for_asset(
            asset,
            payload.text,
            frame_id=payload.frame_id,
            use_vlm_fo1=payload.use_vlm_fo1,
        )
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam/box-prompt")
def sam_box_prompt_endpoint(
    asset_id: uuid.UUID,
    payload: SamBoxIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """SAM 3 box prompt — returns the refined mask for the supplied boxes.

    Same upstream error mapping as the text-prompt endpoint. The
    backend additionally validates ``boxes``/``box_labels`` length
    parity and label values via the SAM service layer.
    """
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    if len(payload.boxes) != len(payload.box_labels):
        raise HTTPException(
            status_code=422,
            detail="boxes and box_labels must have equal length",
        )
    try:
        return sam_box_prompt_for_asset(
            asset,
            payload.boxes,
            payload.box_labels,
            text=payload.text,
            frame_id=payload.frame_id,
        )
    except AppError as exc:
        raise _http(exc) from exc


class TrackStartIn(BaseModel):
    frame_idx: int = Field(default=0, ge=0)
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    text: str | None = None


class TrackAddObjectIn(BaseModel):
    frame_idx: int = Field(ge=0)
    # Cap obj_id at 256: tracking that many distinct objects in a single
    # video session is already unusual, and the bound prevents a buggy or
    # malicious caller from triggering unbounded session-state growth on
    # the model side.
    obj_id: int = Field(default=1, ge=1, le=256)
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    boxes: list[list[float]] = Field(default_factory=list)
    # Plan 11 Task 4 — multiplex text prompt (SAM 3.1). When supplied the
    # model service routes to ``add_text_prompt`` and the response shape
    # changes to ``{obj_ids: [...], frame_idx}``.
    text: str | None = Field(default=None, max_length=200)


@router.post("/{asset_id}/sam-track/start")
def sam_track_start_endpoint(
    asset_id: uuid.UUID,
    payload: TrackStartIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    # Multi-object workflow: empty points + labels is OK (objects are added
    # via /objects later). Length-match is only enforced when points are given.
    if payload.points and len(payload.points) != len(payload.labels):
        raise HTTPException(status_code=422, detail="points and labels must have equal length")
    try:
        return _track_start(
            asset,
            payload.frame_idx,
            payload.points,
            payload.labels,
            text=payload.text,
        )
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam-track/{session_id}/objects")
def sam_track_add_object_endpoint(
    asset_id: uuid.UUID,
    session_id: str,
    payload: TrackAddObjectIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    # Plan 11 Task 4 — text prompts bypass point/box validation; multiplex
    # auto-creates obj_ids per detection on the model service.
    has_text = payload.text is not None and payload.text != ""
    if not has_text:
        if not payload.points and not payload.boxes:
            raise HTTPException(status_code=422, detail="object_requires_points_or_boxes")
        if payload.points and len(payload.points) != len(payload.labels):
            raise HTTPException(status_code=422, detail="points and labels must have equal length")
    try:
        return _track_add_object(
            session_id,
            payload.frame_idx,
            payload.obj_id,
            payload.points,
            payload.labels,
            payload.boxes,
            text=payload.text if has_text else None,
        )
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam-track/{session_id}/step")
def sam_track_step_endpoint(
    asset_id: uuid.UUID,
    session_id: str,
    frames: int = 1,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        return _track_step(session_id, frames)
    except AppError as exc:
        raise _http(exc) from exc


@router.delete(
    "/{asset_id}/sam-track/{session_id}/objects/{obj_id}", status_code=204,
)
def sam_track_remove_object_endpoint(
    asset_id: uuid.UUID,
    session_id: str,
    obj_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Plan 11 Task 4 — proxy DELETE to the model service. 422 when the
    active backend is not the SAM 3.1 multiplex adapter."""
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        _track_remove_object(session_id, obj_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/{asset_id}/sam-track/{session_id}/reset", status_code=204)
def sam_track_reset_endpoint(
    asset_id: uuid.UUID,
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Plan 11 Task 4 — proxy POST to the model service to reset multiplex
    session text prompts. 422 when the active backend is not multiplex."""
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        _track_reset_session(session_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.delete("/{asset_id}/sam-track/{session_id}", status_code=204)
def sam_track_release_endpoint(
    asset_id: uuid.UUID,
    session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        require_visible_task(db, user, asset.task_id)
    except AppError as exc:
        raise _http(exc) from exc
    try:
        _track_release(session_id)
    except AppError as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# v3.23 — YOLOE: Real-Time Seeing Anything.
#
# Three sync per-asset endpoints (text / visual / prompt-free), one batch
# enqueue + poll + cancel set, and a capability probe. The handlers are
# thin wrappers around ``carve_api.inference.yoloe`` — same service-layer
# split the YOLO and SAM paths use.
# ---------------------------------------------------------------------------


class YoloeStatusOut(BaseModel):
    available: bool = False
    text_available: bool = False
    pf_available: bool = False
    text_loaded: bool = False
    pf_loaded: bool = False
    device: str = "unknown"


@inference_yoloe_router.get("/yoloe/status", response_model=YoloeStatusOut)
def yoloe_status_endpoint(
    user: User = Depends(get_current_user),  # noqa: ARG001 — auth gate only
) -> YoloeStatusOut:
    """Capability probe: hides the editor toolbar entry when YOLOE is off."""
    from carve_api.inference.yoloe import get_status

    return YoloeStatusOut(**get_status())


class YoloeTextPromptItem(BaseModel):
    """One (project class -> text prompt) pair for text mode.

    Multiple items per request let the caller target several project
    classes in a single model forward pass: each detection's
    ``class_name`` (which is the prompt string YOLOE was set up with)
    is mapped back to the source ``class_id`` at persistence time.
    """

    class_id: uuid.UUID
    prompt: str = Field(..., min_length=1, max_length=200)


class YoloeTextIn(BaseModel):
    prompts: list[YoloeTextPromptItem] = Field(
        ..., min_length=1, max_length=100,
    )
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    min_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    overwrite: bool = False
    frame_id: uuid.UUID | None = None
    # v3.23.4 — default flipped to "bbox" since most users start with
    # boxes and convert to polygons later via the SAM-refine flow.
    output_kind: str = Field(default="bbox", pattern="^(bbox|polygon)$")


class YoloeVisualGroupIn(BaseModel):
    """One (project class -> reference bbox(es)) group for visual mode."""

    class_id: uuid.UUID
    # 256 is comfortably above any realistic single-class reference
    # count; the Pydantic cap exists only to guard against a runaway
    # client. YOLOE itself has no fixed visual-prompt limit.
    bboxes: list[list[float]] = Field(..., min_length=1, max_length=256)


class YoloeVisualSourceIn(BaseModel):
    """One source asset and the class-keyed bbox groups inside it.

    The bbox coordinates are in this source asset's coordinate space.
    Multiple sources per request let the user mix references from
    several different assets in a single run; the api fetches each
    source's bytes from MinIO and orchestrates one YOLOE pass per
    (source, target) pair, then merges per-target detections via
    cross-source NMS.
    """

    asset_id: uuid.UUID
    groups: list[YoloeVisualGroupIn] = Field(
        ..., min_length=1, max_length=64,
    )


class YoloeVisualIn(BaseModel):
    """Visual-prompt body (v3.24).

    The caller picks reference bboxes from one or more **source
    assets** in the task and assigns each to a project class via
    ``sources[*].groups[*]``. The api orchestrates one YOLOE pass per
    (source, target) pair and merges per-target detections.

    Legacy single-source fields ``refer_b64`` / ``refer_asset_id`` /
    top-level ``groups`` are still accepted for back-compat (older
    clients and the auto-converter); when ``sources`` is supplied the
    legacy fields are ignored.
    """

    # v3.24 — preferred field. List of distinct source assets, each
    # with its own class-keyed bbox groups.
    sources: list[YoloeVisualSourceIn] | None = Field(
        default=None, min_length=1, max_length=32,
    )
    # Legacy single-source fields. Deprecated; kept so older clients
    # don't break. The endpoint converts them into a single-entry
    # ``sources`` list internally.
    refer_b64: str | None = Field(default=None)
    refer_asset_id: uuid.UUID | None = None
    groups: list[YoloeVisualGroupIn] | None = Field(default=None)

    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    min_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    overwrite: bool = False
    frame_id: uuid.UUID | None = None
    output_kind: str = Field(default="bbox", pattern="^(bbox|polygon)$")


class YoloePromptFreeIn(BaseModel):
    annotate_as_class_id: uuid.UUID | None = None
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    min_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    max_detections: int | None = Field(default=None, ge=1, le=1000)
    overwrite: bool = False
    frame_id: uuid.UUID | None = None
    output_kind: str = Field(default="bbox", pattern="^(bbox|polygon)$")


def _resolve_yoloe_asset_bytes(
    asset: Asset, frame_id: uuid.UUID | None,
) -> bytes:
    """Fetch image bytes for YOLOE — first frame for videos when no
    explicit frame_id is given."""
    from carve_api.assets.models import Frame
    from carve_api.db import get_session_factory
    from carve_api.inference.autoannotate import fetch_asset_bytes

    if frame_id is None and getattr(asset, "kind", None) == "video":
        SessionLocal = get_session_factory()
        with SessionLocal() as s:
            f = s.execute(
                select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
            ).scalar_one_or_none()
            if f is not None:
                frame_id = f.id
    return fetch_asset_bytes(asset, frame_id=frame_id)


def _yoloe_response(
    db: Session, result,  # noqa: ANN001 — AutoAnnotateResult
) -> AutoAnnotateResponse:
    db.commit()
    return AutoAnnotateResponse(
        annotations=[AnnotationOut.from_orm_annotation(a) for a in result.annotations],
        annotations_created=result.annotations_created,
        skipped_count=result.skipped_count,
        skipped_by_class=dict(result.skipped_by_class),
        overwrite_skipped=bool(result.overwrite_skipped),
    )


@router.post("/{asset_id}/yoloe/text", response_model=AutoAnnotateResponse)
def yoloe_text_predict_endpoint(
    asset_id: uuid.UUID,
    payload: YoloeTextIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoAnnotateResponse:
    from carve_api.inference.yoloe import (
        YoloeMode,
        YoloeOutputKind,
        YoloeTextParams,
        YoloeTextPrompt,
        apply_yoloe_to_asset,
    )

    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, asset.task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    image_bytes = _resolve_yoloe_asset_bytes(asset, payload.frame_id)
    try:
        result = apply_yoloe_to_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            image_bytes=image_bytes,
            mode=YoloeMode.text,
            params=YoloeTextParams(
                prompts=[
                    YoloeTextPrompt(class_id=p.class_id, prompt=p.prompt)
                    for p in payload.prompts
                ],
                conf=payload.conf,
                iou=payload.iou,
            ),
            overwrite=payload.overwrite,
            min_confidence=payload.min_confidence,
            output_kind=YoloeOutputKind(payload.output_kind),
        )
    except AppError as exc:
        raise _http(exc) from exc
    return _yoloe_response(db, result)


@router.post("/{asset_id}/yoloe/visual", response_model=AutoAnnotateResponse)
def yoloe_visual_predict_endpoint(
    asset_id: uuid.UUID,
    payload: YoloeVisualIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoAnnotateResponse:
    import base64 as _b64

    from carve_api.inference.yoloe import (
        YoloeMode,
        YoloeOutputKind,
        YoloeVisualGroup,
        YoloeVisualParams,
        YoloeVisualSource,
        apply_yoloe_to_asset,
    )

    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, asset.task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    # v3.24 — multi-source visual prompts. Build a typed list of
    # ``YoloeVisualSource`` from whichever wire shape the client
    # supplied:
    #
    # Preferred:
    #   sources: [{asset_id, groups: [{class_id, bboxes}]}]
    #
    # Legacy single-source (back-compat — auto-converted):
    #   refer_b64 OR refer_asset_id, plus top-level groups.
    #
    # Each source's bytes are fetched ONCE here; the orchestrator in
    # ``predict_for_asset`` then runs YOLOE per (source, target) and
    # NMS-merges per-target detections.
    typed_sources: list[YoloeVisualSource] = []
    if payload.sources:
        # Preferred path: one entry per distinct source asset.
        for s in payload.sources:
            source_asset = db.get(Asset, s.asset_id)
            if source_asset is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"source_asset_not_found:{s.asset_id}",
                )
            try:
                require_visible_task(db, user, source_asset.task_id)
            except AppError as exc:
                raise _http(exc) from exc
            refer_bytes = _resolve_yoloe_asset_bytes(source_asset, None)
            typed_sources.append(
                YoloeVisualSource(
                    asset_id=source_asset.id,
                    refer_bytes=refer_bytes,
                    groups=[
                        YoloeVisualGroup(
                            class_id=g.class_id,
                            bboxes=[list(b) for b in g.bboxes],
                        )
                        for g in s.groups
                    ],
                ),
            )
    else:
        # Legacy single-source path — convert to one-source shape.
        refer_bytes: bytes | None = None
        if payload.refer_b64:
            try:
                refer_bytes = _b64.b64decode(payload.refer_b64)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=422, detail="bad_refer_b64",
                ) from exc
        elif payload.refer_asset_id is not None:
            refer_asset = db.get(Asset, payload.refer_asset_id)
            if refer_asset is None:
                raise HTTPException(
                    status_code=404, detail="refer_asset_not_found",
                )
            try:
                require_visible_task(db, user, refer_asset.task_id)
            except AppError as exc:
                raise _http(exc) from exc
            refer_bytes = _resolve_yoloe_asset_bytes(refer_asset, None)
        if not payload.groups:
            raise HTTPException(
                status_code=422,
                detail="visual_request_requires_sources_or_groups",
            )
        typed_sources.append(
            YoloeVisualSource(
                asset_id=payload.refer_asset_id,
                refer_bytes=refer_bytes,
                groups=[
                    YoloeVisualGroup(
                        class_id=g.class_id,
                        bboxes=[list(b) for b in g.bboxes],
                    )
                    for g in payload.groups
                ],
            ),
        )

    image_bytes = _resolve_yoloe_asset_bytes(asset, payload.frame_id)
    try:
        result = apply_yoloe_to_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            image_bytes=image_bytes,
            mode=YoloeMode.visual,
            params=YoloeVisualParams(
                sources=typed_sources,
                conf=payload.conf,
                iou=payload.iou,
            ),
            overwrite=payload.overwrite,
            min_confidence=payload.min_confidence,
            output_kind=YoloeOutputKind(payload.output_kind),
        )
    except AppError as exc:
        raise _http(exc) from exc
    return _yoloe_response(db, result)


@router.post("/{asset_id}/yoloe/prompt-free", response_model=AutoAnnotateResponse)
def yoloe_prompt_free_predict_endpoint(
    asset_id: uuid.UUID,
    payload: YoloePromptFreeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoAnnotateResponse:
    from carve_api.inference.yoloe import (
        YoloeMode,
        YoloeOutputKind,
        YoloePromptFreeParams,
        apply_yoloe_to_asset,
    )

    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    try:
        task = require_visible_task(db, user, asset.task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    image_bytes = _resolve_yoloe_asset_bytes(asset, payload.frame_id)
    try:
        result = apply_yoloe_to_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            image_bytes=image_bytes,
            mode=YoloeMode.prompt_free,
            params=YoloePromptFreeParams(
                annotate_as_class_id=payload.annotate_as_class_id,
                conf=payload.conf,
                iou=payload.iou,
                max_detections=payload.max_detections,
            ),
            overwrite=payload.overwrite,
            min_confidence=payload.min_confidence,
            output_kind=YoloeOutputKind(payload.output_kind),
        )
    except AppError as exc:
        raise _http(exc) from exc
    return _yoloe_response(db, result)


# ---------------------------------------------------------------------------
# Batch (all assets in task) — async via RQ + Redis progress hash.
# ---------------------------------------------------------------------------


class YoloeBatchIn(BaseModel):
    """Request body for ``POST /tasks/{task_id}/yoloe/batch``.

    ``mode`` selects which YOLOE mode to run; ``params`` carries the
    mode-specific config the worker needs to re-build typed param
    objects:

    * mode="text"        : ``{"classes": ["person", ...], "conf": 0.25, "iou": 0.7}``
    * mode="visual"      : ``{"refer_b64": "...", "bboxes": [[x1,y1,x2,y2]],
                              "cls_indices": [0,...], "class_names": [...],
                              "annotate_as_class_id": "<uuid>", "conf": 0.25, "iou": 0.7}``
    * mode="prompt_free" : ``{"annotate_as_class_id": "<uuid>" | None,
                              "conf": 0.25, "iou": 0.7,
                              "max_detections": int | None}``
    """

    mode: str = Field(..., pattern="^(text|visual|prompt_free)$")
    params: dict = Field(default_factory=dict)
    overwrite: bool = False
    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    # v3.23.3 — choose between bbox-only or polygon-only persistence.
    # Default polygon (instance-segmentation models output masks).
    output_kind: str = Field(default="polygon", pattern="^(bbox|polygon)$")


@task_inference_router.post("/{task_id}/yoloe/batch")
def enqueue_yoloe_batch(
    task_id: uuid.UUID,
    payload: YoloeBatchIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from carve_api.inference.batch import build_yoloe_payload, run_yoloe_batch

    try:
        task = require_visible_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc

    job_payload = build_yoloe_payload(
        actor=user,
        task=task,
        mode=payload.mode,
        params=payload.params,
        overwrite=payload.overwrite,
        min_confidence=payload.min_confidence,
        output_kind=payload.output_kind,
    )
    try:
        from rq import Queue

        from carve_api.jobs.queue import enqueue_with_defaults

        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            enqueue_with_defaults(
                q,
                run_yoloe_batch,
                job_payload,
                job_id=job_payload.job_id,
                job_timeout=2 * 3600,
            )
    except Exception:  # noqa: BLE001 — same best-effort enqueue as the YOLO batch
        pass
    return {"job_id": job_payload.job_id}


@task_inference_router.get(
    "/{task_id}/yoloe/batch/{job_id}",
    response_model=BatchAutoAnnotateProgress,
)
def get_yoloe_batch_progress(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return read_progress(_redis_client_or_none(), job_id)


@task_inference_router.post(
    "/{task_id}/yoloe/batch/{job_id}/cancel",
    status_code=202,
)
def cancel_yoloe_batch(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis_client_or_none()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    try:
        from carve_api.inference.batch import progress_key

        # v3.23.5 — don't trample a terminal status. A stale cancel
        # click (e.g. after the job already finished or was already
        # canceled) shouldn't overwrite the real outcome — the user
        # would see "canceled" with the previously-created counts and
        # think their work was lost.
        cur = client.hget(progress_key(job_id), "status")
        if isinstance(cur, bytes):
            cur = cur.decode("utf-8", errors="ignore")
        if cur in (
            "completed",
            "completed_with_errors",
            "failed",
            "canceled",
        ):
            return {"job_id": job_id, "status": cur or "canceled"}
        client.hset(progress_key(job_id), "status", "canceled")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="cancel_failed") from None
    _try_send_stop(client, job_id)
    return {"job_id": job_id, "status": "canceled"}
