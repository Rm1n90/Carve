"""Annotation import HTTP endpoints."""

import uuid
from io import BytesIO
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from carve_api.annotations.router import _require_visible_task
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.io.import_job import ImportJobPayload, read_progress, run_import_job
from carve_api.storage.client import MinioClient


router = APIRouter(prefix="/tasks", tags=["import"])


_MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB
_ALLOWED_EXT = {"yolo": "zip", "coco": "json"}


def _redis_client_or_none():
    """Best-effort Redis client; returns None when unreachable."""
    from redis import Redis

    from carve_api.config import get_settings

    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None


@router.post("/{task_id}/imports", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_import(
    task_id: uuid.UUID,
    fmt: Literal["yolo", "coco"] = Query(..., alias="format"),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    body = await file.read()
    if len(body) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="import_too_large")

    # Light extension check — YOLO needs a zip; COCO accepts a zip OR a json file.
    fname = (file.filename or "").lower()
    if fmt == "yolo" and not fname.endswith(".zip"):
        raise HTTPException(status_code=400, detail="yolo_import_requires_zip")
    if fmt == "coco" and not (fname.endswith(".zip") or fname.endswith(".json")):
        raise HTTPException(status_code=400, detail="coco_import_requires_zip_or_json")

    import_id = uuid.uuid4()
    ext = "zip" if fname.endswith(".zip") else "json"
    minio_key = f"imports/{task.id}/{import_id}.{ext}"
    storage = MinioClient.from_settings()
    storage.ensure_bucket()
    storage.put_object(minio_key, BytesIO(body), len(body), file.content_type or "application/octet-stream")

    payload = ImportJobPayload(
        job_id=str(import_id),
        actor_id=str(user.id),
        task_id=str(task.id),
        import_id=str(import_id),
        minio_key=minio_key,
        fmt=fmt,
    )

    # Best-effort enqueue; if Redis/RQ unreachable, the user can retry the GET later.
    try:
        from rq import Queue
        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            q.enqueue(run_import_job, payload)
    except Exception:
        pass

    return {"import_id": str(import_id)}


@router.get("/{task_id}/imports/{import_id}")
def get_import_progress(
    task_id: uuid.UUID,
    import_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _require_visible_task(db, user, task_id)
    return read_progress(_redis_client_or_none(), import_id)
