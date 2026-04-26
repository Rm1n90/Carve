"""Per-task analytics endpoints."""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from vaa_api.annotations.router import _require_visible_task
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
from vaa_api.stats.heatmap import heatmap
from vaa_api.stats.service import StatsService


router = APIRouter(prefix="/tasks", tags=["stats"])


@router.get("/{task_id}/stats/class-frequency")
def class_frequency(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    task = _require_visible_task(db, user, task_id)
    return StatsService(db).class_frequency(project_id=task.project_id, task_id=task.id)


@router.get("/{task_id}/stats/density")
def density(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    task = _require_visible_task(db, user, task_id)
    return StatsService(db).annotation_density(task_id=task.id)


@router.get("/{task_id}/stats/progress")
def progress(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    return StatsService(db).task_progress(task_id=task.id)


@router.get("/{task_id}/stats/size-distribution")
def size_distribution(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    return StatsService(db).size_distribution(task_id=task.id)


@router.get("/{task_id}/stats/aspect-ratio")
def aspect_ratio(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    return StatsService(db).aspect_ratio_histogram(task_id=task.id)


@router.get("/{task_id}/stats/heatmap")
def heatmap_endpoint(
    task_id: uuid.UUID,
    bins: int = Query(default=32, ge=1, le=128),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    task = _require_visible_task(db, user, task_id)
    grid = heatmap(db, task.id, bins=bins)
    return {"bins": bins, "grid": grid}
