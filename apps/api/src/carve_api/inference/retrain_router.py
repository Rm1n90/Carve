"""Active-learning retrain REST endpoints (plan-09 task-05).

  * ``POST   /tasks/{tid}/retrain-yolo``           — enqueue a retrain RQ job.
  * ``GET    /tasks/{tid}/retrain-yolo/{job_id}``  — read the Redis hash.
  * ``DELETE /tasks/{tid}/retrain-yolo/{job_id}``  — cancel + purge dataset.

All three gates on :func:`carve_api.projects.service.require_visible_task`
(project member/admin) and translate ``AppError`` to HTTP via the same
helper the rest of the inference router uses.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.jobs.retrain import (
    build_payload,
    progress_key,
    read_progress,
    run_retrain_job,
)
from carve_api.projects.service import require_visible_task


router = APIRouter(prefix="/tasks", tags=["retrain"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _redis_client_or_none() -> Redis | None:
    s = get_settings()
    try:
        client = Redis(
            host=s.redis_host,
            port=s.redis_port,
            socket_connect_timeout=1,
            decode_responses=True,
        )
        client.ping()
        return client
    except Exception:  # noqa: BLE001
        return None


class RetrainIn(BaseModel):
    base_weight_id: uuid.UUID | None = None
    epochs: int = Field(default=30, ge=1, le=200)
    imgsz: int = Field(default=640, ge=320, le=1280)
    include_proposed: bool = False
    weight_name: str | None = Field(default=None, max_length=120)


class RetrainEnqueueOut(BaseModel):
    job_id: str


class RetrainProgressOut(BaseModel):
    phase: str
    progress_pct: int
    error: str | None = None
    error_traceback: str | None = None
    weight_id: str | None = None


@router.post(
    "/{task_id}/retrain-yolo",
    response_model=RetrainEnqueueOut,
)
def enqueue_retrain(
    task_id: uuid.UUID,
    payload: RetrainIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RetrainEnqueueOut:
    # Imgsz divisible-by-32 is also enforced by the model service, but
    # 422 here keeps the round-trip short for obvious bad inputs.
    if payload.imgsz % 32 != 0:
        raise HTTPException(
            status_code=422, detail="imgsz_not_divisible_by_32"
        )
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc

    job_payload = build_payload(
        actor_id=user.id,
        task_id=task.id,
        base_weight_id=payload.base_weight_id,
        epochs=payload.epochs,
        imgsz=payload.imgsz,
        include_proposed=payload.include_proposed,
        weight_name=payload.weight_name,
    )

    # Best-effort enqueue (mirrors the auto-annotate batch path). If Redis is
    # down we still return the job_id so the client can poll once Redis is back.
    try:
        from rq import Queue

        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            q.enqueue(run_retrain_job, job_payload, job_timeout=24 * 3600)
    except Exception:  # noqa: BLE001
        pass

    return RetrainEnqueueOut(job_id=job_payload.job_id)


@router.get(
    "/{task_id}/retrain-yolo/{job_id}",
    response_model=RetrainProgressOut,
)
def get_retrain_progress(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RetrainProgressOut:
    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    snap = read_progress(_redis_client_or_none(), job_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="job_not_found")
    return RetrainProgressOut(**snap)


@router.delete(
    "/{task_id}/retrain-yolo/{job_id}",
    status_code=202,
)
def cancel_retrain(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc

    # Best-effort RQ cancel — fetch_job(...) returns None / raises if Redis
    # hasn't heard of this job (already finished, never enqueued, ...).
    client = _redis_client_or_none()
    if client is not None:
        try:
            from rq.job import Job

            try:
                Job.fetch(job_id, connection=client).cancel()
            except Exception:  # noqa: BLE001 — job may not exist
                pass
            # Mark the hash so polling reflects the cancel even if the
            # worker hasn't observed it yet.
            try:
                client.hset(
                    progress_key(job_id),
                    mapping={"phase": "error", "error": "canceled"},
                )
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            pass

    # Best-effort purge of the dataset zip.
    try:
        from carve_api.storage.client import MinioClient

        storage = MinioClient.from_settings()
        storage.remove_object(f"retrain/{task.id}/{job_id}/dataset.zip")
    except Exception:  # noqa: BLE001
        pass

    return {"job_id": job_id, "status": "canceled"}
