"""Per-task and per-project analytics endpoints."""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.service import ProjectService, require_visible_task
from carve_api.stats.heatmap import heatmap
from carve_api.stats.service import StatsService


router = APIRouter(prefix="/tasks", tags=["stats"])
project_router = APIRouter(prefix="/projects", tags=["stats"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.get("/{task_id}/stats/class-frequency")
def class_frequency(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).class_frequency(project_id=task.project_id, task_id=task.id)


@router.get("/{task_id}/stats/density")
def density(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).annotation_density(task_id=task.id)


@router.get("/{task_id}/stats/progress")
def progress(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).task_progress(task_id=task.id)


@router.get("/{task_id}/stats/size-distribution")
def size_distribution(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).size_distribution(task_id=task.id)


@router.get("/{task_id}/stats/aspect-ratio")
def aspect_ratio(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).aspect_ratio_histogram(task_id=task.id)


@router.get("/{task_id}/stats/heatmap")
def heatmap_endpoint(
    task_id: uuid.UUID,
    bins: int = Query(default=32, ge=1, le=128),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    grid = heatmap(db, task.id, bins=bins)
    return {"bins": bins, "grid": grid}


@router.get("/{task_id}/stats/time-on-task")
def time_on_task(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).time_on_task(task_id=task.id)


# ---------------------------------------------------------------------------
# Plan-13 Phase 7 Task 10 — quality dashboard endpoints.
# ---------------------------------------------------------------------------
@project_router.get("/{project_id}/stats/reviewer-quality")
def reviewer_quality(
    project_id: uuid.UUID,
    from_ts: datetime | None = Query(default=None, alias="from"),
    to_ts: datetime | None = Query(default=None, alias="to"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    items = StatsService(db).reviewer_quality(
        project_id=project.id, from_ts=from_ts, to_ts=to_ts
    )
    return {"items": items}


@project_router.get("/{project_id}/stats/retrain-history")
def retrain_history(
    project_id: uuid.UUID,
    limit: int = Query(default=20, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    items = StatsService(db).retrain_history(project_id=project.id, limit=limit)
    return {"items": items}


@router.get("/{task_id}/stats/per-class-quality")
def per_class_quality(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    items = StatsService(db).per_class_quality(
        project_id=task.project_id, task_id=task.id
    )
    return {"items": items}


@project_router.get("/{project_id}/stats")
def project_summary(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Project-level analytics rollup.

    Mirrors the auth pattern used by `GET /projects/{project_id}` — unknown or
    invisible projects collapse into a 404 (Plan 02 IDOR-mitigation policy).
    """
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
    except AppError as exc:
        raise _http(exc) from exc
    return StatsService(db).project_summary(project_id=project.id)
