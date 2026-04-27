import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import Redis
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
    sam_decode_with_hash,
    sam_encode_for_asset,
)
from carve_api.inference.sam_track import (
    add_object as _track_add_object,
    release as _track_release,
    start as _track_start,
    step as _track_step,
)
from carve_api.weights.models import Weight


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


@router.post("/{asset_id}/auto-annotate", response_model=list[AnnotationOut])
def auto_annotate(
    asset_id: uuid.UUID,
    weight_id: uuid.UUID,
    overwrite: bool = False,
    min_confidence: float = 0.0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AnnotationOut]:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    task = _require_visible_task(db, user, asset.task_id)
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    # Clamp incoming `min_confidence` so a misbehaving client can't bypass
    # the bounds. The slider in the UI is 0..1; anything else is a bug.
    min_confidence = max(0.0, min(1.0, float(min_confidence)))
    try:
        body = fetch_asset_bytes(asset)
        url = presigned_url_for_weight(weight)
        anns = auto_annotate_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            weight=weight,
            overwrite=overwrite,
            presigned_url_for_weight=url,
            image_bytes=body,
            min_confidence=min_confidence,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return [AnnotationOut.from_orm_annotation(a) for a in anns]


@task_inference_router.post("/{task_id}/auto-annotate")
def enqueue_batch_auto_annotate(
    task_id: uuid.UUID,
    weight_id: uuid.UUID,
    overwrite: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    if weight.project_id != task.project_id:
        raise HTTPException(status_code=400, detail="weight_project_mismatch")

    payload = build_job_payload(actor=user, task=task, weight=weight, overwrite=overwrite)

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
