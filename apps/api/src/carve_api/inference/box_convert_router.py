# Armin Mehri — mehri.armin@gmail.com
"""Task-wide box -> polygon / mask conversion: start, watch, stop, resume.

The job itself is :mod:`carve_api.inference.box_convert_batch`. A task
has at most one conversion running; the dialog asks for the task's
latest one, so it finds a running conversion after a reload or from
another browser.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.inference import box_convert_batch as bc
from carve_api.inference.batch import _b2s, progress_key, read_cursor
from carve_api.permissions import require_gpu_task
from carve_api.projects.service import _MUTATING_ROLES, require_project_role

log = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["box-convert"])


def _redis():
    from carve_api.inference.router import _redis_client_or_none

    return _redis_client_or_none()


def _http(exc: AppError) -> HTTPException:
    from carve_api.inference.router import _http as to_http

    return to_http(exc)


def _summary(db: Session, task_id: uuid.UUID) -> dict:
    boxes, images = db.execute(
        select(func.count(), func.count(func.distinct(Annotation.frame_id))).where(
            Annotation.task_id == task_id, Annotation.kind == AnnotationKind.bbox
        )
    ).one()
    return {"boxes": int(boxes), "images": int(images)}


def _job_or_404(client, task_id: uuid.UUID, job_id: str) -> dict:
    p = bc.read_convert_progress(client, job_id, recent=0)
    if p.get("task_id") not in (None, str(task_id)) or p["status"] == "pending":
        raise HTTPException(status_code=404, detail="job_not_found")
    return p


class StartIn(BaseModel):
    asset_ids: list[uuid.UUID] | None = Field(default=None, max_length=200_000)


@router.get("/{task_id}/sam/box-convert")
def get_box_convert(
    task_id: uuid.UUID,
    recent: int = Query(default=24, ge=0, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """The task's latest conversion (or none) and the boxes left; those
    are not counted while a run goes (polled every few seconds, and a
    count over a million boxes is not free)."""
    try:
        require_gpu_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis()
    jid = bc.latest_job_id(client, task_id)
    job = bc.read_convert_progress(client, jid, recent=recent) if jid else None
    if job is not None and job["status"] == "pending":
        job = None
    running = job is not None and job["status"] in ("queued", "running", "waiting_for_gpu")
    return {"job": job, "left": None if running else _summary(db, task_id)}


@router.post("/{task_id}/sam/box-convert", status_code=202)
def start_box_convert(
    task_id: uuid.UUID,
    payload: StartIn | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_gpu_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    if bc.active_job_id(client, task_id):
        raise HTTPException(
            status_code=409,
            detail={"error": "already_running", "job_id": bc.active_job_id(client, task_id)},
        )
    from carve_api.logo_ai.models import TERMINAL_STATUSES, LogoAiJob

    if db.execute(
        select(LogoAiJob.id).where(
            LogoAiJob.task_id == task_id, LogoAiJob.status.notin_(TERMINAL_STATUSES)
        )
    ).first():
        raise HTTPException(status_code=409, detail={"error": "logo_ai_running"})
    if _summary(db, task_id)["boxes"] == 0:
        raise HTTPException(status_code=422, detail={"error": "no_boxes"})
    try:
        st = bc._sam_status()
    except Exception:  # noqa: BLE001
        st = {}
    if st.get("state") == "ready" and st.get("variant") != bc.SAM_VARIANT:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "wrong_sam_variant",
                "loaded": st.get("variant"),
                "needed": bc.SAM_VARIANT,
            },
        )

    job = bc.build_payload(
        actor=user,
        task=task,
        asset_ids=[str(a) for a in payload.asset_ids] if payload and payload.asset_ids else None,
    )
    from carve_api.inference.batch import count_assets_for_task, prepare_progress

    total = len(job.asset_ids) if job.asset_ids else count_assets_for_task(db, task_id)
    prepare_progress(client, job.job_id, total, kind=bc.KIND)
    client.hset(progress_key(job.job_id), mapping={"task_id": str(task_id)})
    if job.asset_ids:
        client.set(bc.assets_key(job.job_id), ",".join(job.asset_ids), ex=bc._KEEP_SECONDS)
    try:
        bc._enqueue(job, job.job_id, connection=client)
    except Exception as exc:
        log.exception("box_convert: enqueue failed")
        client.hset(progress_key(job.job_id), "status", "failed")
        raise HTTPException(status_code=503, detail="enqueue_failed") from exc
    client.set(bc.task_key(task_id), job.job_id, ex=bc._KEEP_SECONDS)
    return {"job": bc.read_convert_progress(client, job.job_id, recent=0)}


@router.post("/{task_id}/sam/box-convert/{job_id}/cancel", status_code=202)
def cancel_box_convert(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Stops after the image in work, which is saved; nothing is undone."""
    try:
        task = require_gpu_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    _job_or_404(client, task_id, job_id)
    # The worker reads this before every image; a window still queued
    # reads it when it starts and ends there.
    client.hset(progress_key(job_id), "status", "canceled")
    return {"job": bc.read_convert_progress(client, job_id, recent=0)}


@router.post("/{task_id}/sam/box-convert/{job_id}/resume", status_code=202)
def resume_box_convert(
    task_id: uuid.UUID,
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Go on from the image a stopped, failed or stalled run had reached."""
    try:
        task = require_gpu_task(db, user, task_id)
        require_project_role(db, user, task.project_id, _MUTATING_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis()
    if client is None:
        raise HTTPException(status_code=503, detail="redis_unavailable")
    p = _job_or_404(client, task_id, job_id)
    if p["status"] not in ("canceled", "failed") and not p["stalled"]:
        raise HTTPException(status_code=409, detail={"error": "not_stopped", "status": p["status"]})
    other = bc.active_job_id(client, task_id)
    if other and other != job_id:
        raise HTTPException(status_code=409, detail={"error": "already_running", "job_id": other})
    cursor = read_cursor(client, job_id)
    if cursor is None:
        raise HTTPException(status_code=409, detail={"error": "nothing_to_resume"})
    job = bc.BoxConvertPayload(job_id=job_id, actor_id=str(user.id), task_id=str(task_id))
    raw_ids = client.get(bc.assets_key(job_id))
    if raw_ids:
        job.asset_ids = _b2s(raw_ids).split(",")
    client.hset(progress_key(job_id), mapping={"status": "queued", "error": ""})
    try:
        # A fresh RQ id: the finished windows keep theirs.
        bc._enqueue(job, f"{job_id}::r{cursor}-{uuid.uuid4().hex[:6]}", connection=client)
    except Exception as exc:
        client.hset(progress_key(job_id), "status", p["status"])
        raise HTTPException(status_code=503, detail="enqueue_failed") from exc
    client.set(bc.task_key(task_id), job_id, ex=bc._KEEP_SECONDS)
    return {"job": bc.read_convert_progress(client, job_id, recent=0)}


@router.get("/{task_id}/sam/box-convert/{job_id}/log")
def box_convert_log(
    task_id: uuid.UUID,
    job_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=60, ge=1, le=500),
    only: str = Query(default="all", pattern="^(all|flagged|errors)$"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """The converted images, newest first. ``flagged``: a box SAM found
    nothing in, or scored low; ``errors``: images that failed."""
    try:
        require_gpu_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    client = _redis()
    _job_or_404(client, task_id, job_id)
    import json

    raw = [json.loads(_b2s(e)) for e in client.lrange(bc.log_key(job_id), 0, -1)]
    raw.reverse()
    if only == "flagged":
        raw = [e for e in raw if e.get("kept") or e.get("low_score") or e.get("error")]
    elif only == "errors":
        raw = [e for e in raw if e.get("error")]
    return {"total": len(raw), "items": raw[offset : offset + limit]}


@router.get("/{task_id}/assets/{asset_id}/shapes-preview")
def shapes_preview(
    task_id: uuid.UUID,
    asset_id: uuid.UUID,
    w: int = Query(default=640, ge=64, le=2048),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The image with its annotations drawn on it (JPEG)."""
    try:
        require_gpu_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    asset = db.get(Asset, asset_id)
    if asset is None or asset.task_id != task_id:
        raise HTTPException(status_code=404, detail="asset_not_found")
    from carve_api.inference.autoannotate import fetch_asset_bytes
    from carve_api.inference.shapes_preview import render

    body = render(db, task_id, asset, fetch_asset_bytes(asset), width=w)
    return Response(
        content=body, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=30"}
    )
