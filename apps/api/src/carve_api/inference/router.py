import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.router import _require_visible_task
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
    build_job_payload,
    read_progress,
    run_batch_auto_annotate,
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
    start as _track_start,
    step as _track_step,
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
    body: AutoAnnotateBody | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoAnnotateResponse:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    task = _require_visible_task(db, user, asset.task_id)
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
    """

    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
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
    task = _require_visible_task(db, user, task_id)
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
    if body is not None:
        if body.min_confidence is not None:
            # Pydantic already enforced 0..1 via Field(ge=0, le=1).
            min_conf = float(body.min_confidence)
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
        class_overrides=overrides_for_payload,
    )

    # Best-effort enqueue — if Redis/RQ are not reachable, return the job_id anyway
    # so callers can poll later when Redis is back up. Production has Redis up by
    # docker-compose health gates.
    try:
        from rq import Queue
        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            q.enqueue(run_batch_auto_annotate, payload)
    except Exception:
        pass
    return {"job_id": payload.job_id}


@task_inference_router.get("/{task_id}/auto-annotate/{job_id}")
def get_batch_progress(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _require_visible_task(db, user, task_id)
    return read_progress(_redis_client_or_none(), job_id)


class SamDecodeIn(BaseModel):
    image_hash: str
    points: list[list[int]] = Field(min_length=1)
    labels: list[int] = Field(min_length=1)


class SamTextIn(BaseModel):
    """Body for POST /assets/{id}/sam/text-prompt — SAM 3 only.

    A single positive text concept describing the object (e.g. "person").
    Matches the model service's TextPromptIn — see
    ``apps/model/src/carve_model/sam/router.py``.
    """

    text: str = Field(..., min_length=1, max_length=200)


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


@router.post("/{asset_id}/sam/encode")
def sam_encode_endpoint(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    _require_visible_task(db, user, asset.task_id)
    try:
        return sam_encode_for_asset(asset)
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
    _require_visible_task(db, user, asset.task_id)
    try:
        return sam_decode_with_hash(payload.image_hash, payload.points, payload.labels)
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
    _require_visible_task(db, user, asset.task_id)
    try:
        return sam_text_prompt_for_asset(asset, payload.text)
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
    _require_visible_task(db, user, asset.task_id)
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
    obj_id: int = Field(ge=1, le=256)
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    boxes: list[list[float]] = Field(default_factory=list)


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
    _require_visible_task(db, user, asset.task_id)
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
    _require_visible_task(db, user, asset.task_id)
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
    _require_visible_task(db, user, asset.task_id)
    try:
        return _track_step(session_id, frames)
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
    _require_visible_task(db, user, asset.task_id)
    try:
        _track_release(session_id)
    except AppError as exc:
        raise _http(exc) from exc
