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
            enqueue_with_defaults(
                q, run_batch_auto_annotate, payload, job_timeout=2 * 3600
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
    )
    try:
        from rq import Queue
        from carve_api.jobs.queue import enqueue_with_defaults
        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            enqueue_with_defaults(q, run_auto_text_batch, job_payload)
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
    return {"job_id": job_id, "status": "canceled"}


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
        )
    except AutoTextNoEligibleClasses as exc:
        raise _http(exc) from exc
    except AppError as exc:
        # SAM upstream errors (Sam3NotEnabled, SamModelUnreachable,
        # SamModelFailed) get the standard envelope.
        raise _http(exc) from exc
    db.commit()
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
            asset, payload.text, frame_id=payload.frame_id
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
