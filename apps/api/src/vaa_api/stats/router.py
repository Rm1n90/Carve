"""Per-task analytics endpoints."""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from vaa_api.annotations.router import _require_visible_task
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
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
