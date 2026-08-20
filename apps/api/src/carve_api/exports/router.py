# Armin Mehri — mehri.armin@gmail.com
"""Annotation export HTTP endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.audit import service as audit_service
from carve_api.audit.actions import EXPORT_SUBMITTED
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.permissions import data_movement_guard
from carve_api.projects.service import (
    _MUTATING_ROLES,
    require_project_role,
    require_visible_task,
)
from carve_api.exports.job import ExportJobPayload, run_export_job
from carve_api.exports.schemas import ExportIn, ExportProgressOut
from carve_api.exports.service import ExportService
from carve_api.storage.client import MinioClient


# Outsourcing hardening — every route here is a dataset-export path
# (enqueue, kind probe, progress + download URL). The guard is applied
# router-wide so a future export route cannot silently ship ungated.
router = APIRouter(
    prefix="/tasks",
    tags=["export"],
    dependencies=[Depends(data_movement_guard)],
)


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
    # Plan-13 Phase 7 Task 3 — best-effort audit on export submit.
    audit_service.record(
        db,
        actor_id=user.id,
        action=EXPORT_SUBMITTED,
        target_type="export",
        target_id=e.id,
        project_id=task.project_id,
        summary=f"{EXPORT_SUBMITTED} task={task.id} export={e.id} fmt={payload.format}",
        metadata={
            "export_id": str(e.id),
            "task_id": str(task.id),
            "format": payload.format,
            "include_images": bool(payload.include_images),
        },
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
        yolo_mode=payload.yolo_mode,
    )
    try:
        from rq import Queue

        from carve_api.jobs.queue import enqueue_with_defaults

        client = _redis_client_or_none()
        if client is not None:
            q = Queue("default", connection=client)
            # Enqueue via the shared helper so the per-callable ``job_timeout``
            # (run_export_job -> 2h, see jobs/queue._JOB_TIMEOUTS) is applied.
            # A raw ``q.enqueue`` left RQ's 180s default, which SIGKILLed large
            # segmentation exports mid-build and stranded the Export row at
            # 'pending' (the hard kill skips the job's mark_failed handler).
            enqueue_with_defaults(q, run_export_job, job_payload)
    except Exception:
        pass

    return {"export_id": str(e.id)}


# Plan-20.1 — kind composition for the export dialog. Returns a tally of
# annotations on this task by ``kind`` so the YOLO format chooser can
# show the user a warning when the task has ≥2 distinct kinds and pick
# the right plain-language preview line for each option.
@router.get("/{task_id}/annotation-kinds")
def annotation_kinds(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    from sqlalchemy import func, select
    from carve_api.annotations.models import Annotation

    try:
        require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    rows = db.execute(
        select(Annotation.kind, func.count(Annotation.id))
        .where(Annotation.task_id == task_id)
        .group_by(Annotation.kind)
    ).all()
    out: dict[str, int] = {"bbox": 0, "polygon": 0, "mask": 0, "tag": 0}
    for kind, count in rows:
        # ``kind`` arrives as the AnnotationKind enum; ``.value`` gives
        # the lowercase string the client expects.
        key = getattr(kind, "value", str(kind))
        if key in out:
            out[key] = int(count)
    return out


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
            # Plan-20.4 — derive the friendly filename from the MinIO
            # key tail. New keys are
            #   ``exports/<task>/<export>/<root>.zip``
            # so the basename is already the user-friendly name we wrote
            # at build time. Legacy keys ``exports/<task>/<export>.zip``
            # are detected because the basename starts with the export
            # UUID; those fall through to a generic name.
            from pathlib import PurePosixPath
            tail = PurePosixPath(e.minio_key).name
            if tail.endswith(".zip") and not tail.startswith(str(e.id)):
                friendly = tail
            else:
                friendly = "export.zip"
            download_url = storage.presigned_get(
                e.minio_key,
                expires_seconds=3600,
                download_filename=friendly,
                content_type="application/zip",
            )
        except Exception:
            download_url = None
    return ExportProgressOut(
        id=str(e.id),
        status=e.status,
        download_url=download_url,
        error=e.error,
        completed_at=e.completed_at,
    )
