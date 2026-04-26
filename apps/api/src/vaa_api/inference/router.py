import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy.orm import Session

from vaa_api.annotations.router import _require_visible_task
from vaa_api.annotations.schemas import AnnotationOut
from vaa_api.assets.models import Asset
from vaa_api.auth.models import User
from vaa_api.config import get_settings
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError
from vaa_api.inference.autoannotate import (
    auto_annotate_asset,
    fetch_asset_bytes,
    presigned_url_for_weight,
)
from vaa_api.inference.batch import (
    build_job_payload,
    read_progress,
    run_batch_auto_annotate,
)
from vaa_api.inference.sam import (
    sam_decode_with_hash,
    sam_encode_for_asset,
)
from vaa_api.weights.models import Weight


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
