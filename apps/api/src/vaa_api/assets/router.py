import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy.orm import Session

from vaa_api.assets.models import AssetKind
from vaa_api.assets.schemas import AssetOut
from vaa_api.assets.service import AssetService
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError
from vaa_api.projects.models import Task as TaskModel
from vaa_api.projects.service import ProjectService, TaskService, _can_modify, NotProjectOwner
from vaa_api.ratelimit import limiter
from vaa_api.storage.client import MinioClient

router = APIRouter(prefix="/tasks", tags=["assets"])
asset_router = APIRouter(prefix="/assets", tags=["assets"])


def _enqueue_post_upload(asset) -> None:
    """Best-effort enqueue of post-upload work; swallow Redis errors so HTTP returns succeed even if Redis is down."""
    try:
        from vaa_api.jobs.queue import get_queue
        from vaa_api.jobs.thumbs import generate_image_thumbnail, probe_video_metadata
        ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
        q = get_queue()
        if asset.kind == AssetKind.image:
            q.enqueue(generate_image_thumbnail, asset.xxh3_128, ext)
        else:
            q.enqueue(probe_video_metadata, str(asset.id), asset.xxh3_128, ext)
    except Exception:
        # Redis may be unreachable in test/dev; treat job-enqueue failure as non-fatal.
        pass


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
@limiter.limit("100/minute")
async def upload_asset(
    request: Request,
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
    _enqueue_post_upload(asset)
    return AssetOut.from_orm_asset(asset)


@router.get("/{task_id}/assets", response_model=list[AssetOut])
def list_assets(
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    task = _require_visible_task(db, user, task_id)
    return [AssetOut.from_orm_asset(a) for a in AssetService(db).list_for_task(task=task)]


@router.post("/{task_id}/assets:zip", response_model=list[AssetOut], status_code=status.HTTP_201_CREATED)
@limiter.limit("100/minute")
async def upload_archive(
    request: Request,
    task_id: uuid.UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    body = await file.read()
    task = _require_visible_task(db, user, task_id)
    try:
        assets = AssetService(db).upload_archive(task=task, archive_bytes=body)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    for a in assets:
        _enqueue_post_upload(a)
    return [AssetOut.from_orm_asset(a) for a in assets]


@asset_router.get("/{asset_id}")
def get_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from vaa_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    _require_visible_task(db, user, a.task_id)
    svc = AssetService(db)
    ext = a.original_name.rsplit(".", 1)[-1] if "." in a.original_name else "bin"
    return {
        "asset": AssetOut.from_orm_asset(a).model_dump(mode="json"),
        "url": svc.storage.presigned_get(f"assets/{a.xxh3_128}/original.{ext}"),
    }


@asset_router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    from vaa_api.assets.models import Asset
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    task = _require_visible_task(db, user, a.task_id)
    project = ProjectService(db).get(actor=user, project_id=task.project_id)
    if not _can_modify(user, project):
        raise _http(NotProjectOwner("only owner or admin can delete an asset"))
    AssetService(db).delete(asset=a)
    db.commit()
