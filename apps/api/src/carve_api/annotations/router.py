# Armin Mehri — mehri.armin@gmail.com
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.annotations.schemas import (
    AnnotationIn, AnnotationOut, AnnotationPatch, AnnotationStatus, BatchIn, BatchOut,
)
from carve_api.annotations.service import AnnotationService
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.projects.models import Task as TaskModel, TaskKind
from carve_api.projects.service import require_visible_task

router = APIRouter(prefix="/tasks", tags=["annotations"])
ann_router = APIRouter(prefix="/annotations", tags=["annotations"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _require_frame_id_for_image_task(task: TaskModel, frame_id: str | None) -> None:
    """Reject writes to image tasks that omit ``frame_id``.

    v2.5.1 regression guard. Image tasks have exactly one ``Frame`` per
    asset; an annotation without a frame_id can't be tied to a specific
    asset and will appear on every image when the editor lists
    annotations for the task. The frontend now reads
    ``AssetWithUrl.frame_id`` and passes it through, but this validation
    prevents a future regression from silently re-introducing the
    cross-asset bleed.
    """
    if task.kind == TaskKind.image and not frame_id:
        raise HTTPException(
            status_code=422,
            detail="frame_id_required_for_image_task",
        )


@router.post("/{task_id}/annotations", response_model=AnnotationOut, status_code=status.HTTP_201_CREATED)
def create_annotation(
    task_id: uuid.UUID,
    payload: AnnotationIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    _require_frame_id_for_image_task(task, payload.frame_id)
    try:
        a = AnnotationService(db).create(
            task=task, actor_id=user.id,
            frame_id=uuid.UUID(payload.frame_id) if payload.frame_id else None,
            class_id=uuid.UUID(payload.class_id),
            kind=payload.kind, geometry=payload.geometry,
            track_id=uuid.UUID(payload.track_id) if payload.track_id else None,
            z_order=payload.z_order,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return AnnotationOut.from_orm_annotation(a)


@router.get("/{task_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(
    task_id: uuid.UUID,
    frame_id: uuid.UUID | None = None,
    # Phase 5 (plan-09 task-02): optional status filter for the review
    # workflow. ``AnnotationStatus`` is a Literal so FastAPI validates the
    # value at the edge — invalid values come back as 422 automatically.
    status: AnnotationStatus | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AnnotationOut]:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    rows = AnnotationService(db).list_for_task(
        task=task, frame_id=frame_id, status=status
    )
    return [AnnotationOut.from_orm_annotation(a) for a in rows]


# Plan-18 — Bulk classify. Accepts a list of asset_ids on the same image
# task and a class_id; idempotently creates one ``kind=tag`` annotation
# per asset's primary frame. Already-tagged (frame, class) pairs are
# counted as ``skipped``. Video tasks and missing assets are reported as
# ``failed``. All writes happen in a single transaction.
class BulkTagIn(BaseModel):
    asset_ids: list[str] = Field(min_length=1, max_length=1000)
    class_id: str


class BulkTagOut(BaseModel):
    tagged: int
    skipped: int
    failed: int


@router.post("/{task_id}/assets:bulk-tag", response_model=BulkTagOut)
def bulk_tag_assets(
    task_id: uuid.UUID,
    payload: BulkTagIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BulkTagOut:
    from carve_api.assets.models import Asset, AssetKind
    from carve_api.assets.service import AssetService

    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc

    if task.kind != TaskKind.image:
        raise HTTPException(
            status_code=422, detail="bulk_tag_only_supported_on_image_tasks",
        )

    try:
        class_uuid = uuid.UUID(payload.class_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_class_id") from exc

    try:
        asset_uuids = [uuid.UUID(a) for a in payload.asset_ids]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_asset_id") from exc

    asset_svc = AssetService(db)
    ann_svc = AnnotationService(db)
    tagged = 0
    skipped = 0
    failed = 0

    for asset_id in asset_uuids:
        asset = db.get(Asset, asset_id)
        if (
            asset is None
            or asset.task_id != task.id
            or asset.kind != AssetKind.image
        ):
            failed += 1
            continue
        frame_id = asset_svc.primary_frame_id_for(asset)
        if frame_id is None:
            failed += 1
            continue
        existing = db.execute(
            select(Annotation.id).where(
                Annotation.task_id == task.id,
                Annotation.frame_id == uuid.UUID(frame_id),
                Annotation.class_id == class_uuid,
                Annotation.kind == AnnotationKind.tag,
            ).limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            skipped += 1
            continue
        try:
            ann_svc.create(
                task=task, actor_id=user.id,
                frame_id=uuid.UUID(frame_id),
                class_id=class_uuid,
                kind=AnnotationKind.tag,
                geometry={"kind": "tag"},
                track_id=None,
            )
            tagged += 1
        except AppError as exc:
            raise _http(exc) from exc

    db.commit()
    return BulkTagOut(tagged=tagged, skipped=skipped, failed=failed)


@router.post("/{task_id}/annotations:batch", response_model=BatchOut)
def batch(
    task_id: uuid.UUID,
    payload: BatchIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BatchOut:
    try:
        task = require_visible_task(db, user, task_id)
    except AppError as exc:
        raise _http(exc) from exc
    # v2.5.1 — every create entry on an image task must carry a frame_id,
    # otherwise the annotation would bleed across all assets in the task.
    for c in payload.create:
        _require_frame_id_for_image_task(task, c.frame_id)
    svc = AnnotationService(db)
    try:
        created = [
            svc.create(
                task=task, actor_id=user.id,
                frame_id=uuid.UUID(c.frame_id) if c.frame_id else None,
                class_id=uuid.UUID(c.class_id),
                kind=c.kind, geometry=c.geometry,
                track_id=uuid.UUID(c.track_id) if c.track_id else None,
                z_order=c.z_order,
            )
            for c in payload.create
        ]
        # Parallel array of client-supplied temp_ids so the response can
        # echo them back. None for entries without a temp_id. Audit bug M.
        created_temp_ids: list[str | None] = [c.temp_id for c in payload.create]
        updated = []
        for u in payload.update:
            a = svc.update(
                task=task, annotation_id=uuid.UUID(u.id),
                kind=u.kind,
                geometry=u.geometry,
                class_id=uuid.UUID(u.class_id) if u.class_id else None,
                track_id=uuid.UUID(u.track_id) if u.track_id else None,
                z_order=u.z_order,
            )
            updated.append(a)
        deleted: list[str] = []
        for ann_id in payload.delete:
            svc.delete(task=task, annotation_id=uuid.UUID(ann_id))
            deleted.append(ann_id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return BatchOut(
        created=[AnnotationOut.from_orm_annotation(a) for a in created],
        updated=[AnnotationOut.from_orm_annotation(a) for a in updated],
        deleted=deleted,
        created_temp_ids=created_temp_ids,
    )


def _resolve_annotation_for_user(db: Session, user: User, annotation_id: uuid.UUID):
    """Look up the annotation only after confirming task visibility.
    Returns (annotation, task) or raises 404 for both not-found and not-visible
    so existence isn't leaked to unauthorized callers (IDOR mitigation).
    """
    from carve_api.annotations.models import Annotation
    a = db.get(Annotation, annotation_id)
    if a is None:
        raise HTTPException(status_code=404, detail="annotation_not_found")
    try:
        task = require_visible_task(db, user, a.task_id)
    except AppError as exc:
        raise HTTPException(status_code=404, detail="annotation_not_found") from exc
    return a, task


@ann_router.patch("/{annotation_id}", response_model=AnnotationOut)
def patch_annotation(
    annotation_id: uuid.UUID,
    payload: AnnotationPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    _a, task = _resolve_annotation_for_user(db, user, annotation_id)
    try:
        a = AnnotationService(db).update(
            task=task, annotation_id=annotation_id,
            geometry=payload.geometry,
            class_id=uuid.UUID(payload.class_id) if payload.class_id else None,
            track_id=uuid.UUID(payload.track_id) if payload.track_id else None,
            z_order=payload.z_order,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return AnnotationOut.from_orm_annotation(a)


@ann_router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(
    annotation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _a, task = _resolve_annotation_for_user(db, user, annotation_id)
    try:
        AnnotationService(db).delete(task=task, annotation_id=annotation_id)
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()


@ann_router.post("/cleanup-orphaned")
def cleanup_orphaned_image_annotations(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    """Admin-only one-off cleanup of pre-v2.5.1 orphaned annotations.

    Pre-v2.5.1 the editor saved every annotation with ``frame_id=null``
    for image tasks because the asset's primary frame_id wasn't exposed
    on the asset endpoint. After the fix those rows can never appear on
    any asset (the editor now scopes its query by frame_id), but they
    sit in the database forever.

    This endpoint deletes annotations where ``frame_id IS NULL`` AND the
    parent task is an image task. Video tag annotations may legitimately
    have ``frame_id = null`` and are NOT affected.

    Admin only. Returns ``{"deleted": <count>}``.
    """
    from carve_api.auth.models import UserRole

    if user.role != UserRole.admin:
        raise HTTPException(status_code=403, detail="admin_only")
    image_task_ids = db.execute(
        select(TaskModel.id).where(TaskModel.kind == TaskKind.image)
    ).scalars().all()
    if not image_task_ids:
        return {"deleted": 0}
    result = db.execute(
        delete(Annotation).where(
            Annotation.frame_id.is_(None),
            Annotation.task_id.in_(image_task_ids),
        )
    )
    db.commit()
    return {"deleted": int(result.rowcount or 0)}
