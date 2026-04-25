import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from vaa_api.assets.schemas import AssetOut
from vaa_api.assets.service import AssetService
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError
from vaa_api.projects.models import Task as TaskModel
from vaa_api.projects.service import ProjectService, TaskService

router = APIRouter(prefix="/tasks", tags=["assets"])
asset_router = APIRouter(prefix="/assets", tags=["assets"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _require_visible_task(db: Session, user: User, task_id: uuid.UUID) -> TaskModel:
    task = db.get(TaskModel, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    TaskService(db).get(project=project, task_id=task.id)
    return task


@router.post("/{task_id}/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetOut:
    body = await file.read()
    task = _require_visible_task(db, user, task_id)
    try:
        asset = AssetService(db).upload(
            task=task, original_name=file.filename or "unnamed",
            mime=file.content_type or "application/octet-stream", body=body,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return AssetOut.from_orm_asset(asset)


@router.get("/{task_id}/assets", response_model=list[AssetOut])
def list_assets(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    task = _require_visible_task(db, user, task_id)
    return [AssetOut.from_orm_asset(a) for a in AssetService(db).list_for_task(task=task)]
