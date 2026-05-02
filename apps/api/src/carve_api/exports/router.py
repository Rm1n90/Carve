"""Annotation export HTTP endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.service import (
    _MUTATING_ROLES,
    require_project_role,
    require_visible_task,
)
from carve_api.exports.job import ExportJobPayload, run_export_job
from carve_api.exports.schemas import ExportIn, ExportProgressOut
from carve_api.exports.service import ExportService
from carve_api.storage.client import MinioClient


router = APIRouter(prefix="/tasks", tags=["export"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _redis_client_or_none():
    from redis import Redis

    from carve_api.config import get_settings

    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None


@router.post("/{task_id}/exports", status_code=status.HTTP_202_ACCEPTED)
def enqueue_export(
    task_id: uuid.UUID,
    payload: ExportIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
        # Plan-13 Phase 7 Task 2 — export submit is a mutation; viewers 403.
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    e = ExportService(db).create(
        task_id=task.id,
        actor_id=user.id,
        fmt=payload.format,
        class_remap=payload.class_remap,
    )
    db.commit()

    job_payload = ExportJobPayload(
        export_id=str(e.id),
        actor_id=str(user.id),
        task_id=str(task.id),
        fmt=payload.format,
        class_remap=payload.class_remap,
        include_images=payload.include_images,
        splits={"train": payload.splits.train, "val": payload.splits.val, "test": payload.splits.test},
    )
    try:
        from rq import Queue
        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            q.enqueue(run_export_job, job_payload)
    except Exception:
        pass

    return {"export_id": str(e.id)}


@router.get("/{task_id}/exports/{export_id}", response_model=ExportProgressOut)
def get_export_progress(
    task_id: uuid.UUID,
    export_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExportProgressOut:
    try:
        require_visible_task(db, user, task_id)
        e = ExportService(db).get(export_id=export_id)
    except AppError as exc:
        raise _http(exc) from exc
    download_url: str | None = None
    if e.status == "completed" and e.minio_key:
        try:
            storage = MinioClient.from_settings()
            download_url = storage.presigned_get(e.minio_key, expires_seconds=3600)
        except Exception:
            download_url = None
    return ExportProgressOut(
        id=str(e.id),
        status=e.status,
        download_url=download_url,
        error=e.error,
        completed_at=e.completed_at,
    )
