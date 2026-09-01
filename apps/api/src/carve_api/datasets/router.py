# Armin Mehri — mehri.armin@gmail.com
"""HTTP routes for dataset versioning (Plan-13 Phase 7 Task 6).

All endpoints under ``/projects/{project_id}/datasets``:

  * ``GET    /projects/{pid}/datasets``                -- list (READ roles)
  * ``GET    /projects/{pid}/datasets/{id}``           -- detail (READ roles)
  * ``GET    /projects/{pid}/datasets/{a}/diff/{b}``   -- diff (READ roles)
  * ``POST   /projects/{pid}/datasets/{id}/rollback``  -- rollback (ADMIN)
"""

from __future__ import annotations

import io
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.audit import service as audit_service
from carve_api.auth.models import User
from carve_api.datasets.differ import (
    DatasetDiff,
    diff_bundles,
    parse_bundle_for_rollback,
)
from carve_api.datasets.models import DatasetVersion
from carve_api.datasets.schemas import (
    DatasetDiffByImage,
    DatasetDiffOut,
    DatasetVersionDetailOut,
    DatasetVersionOut,
    RollbackIn,
    RollbackOut,
)
from carve_api.datasets.service import DatasetService
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError
from carve_api.permissions import is_admin, require_data_movement
from carve_api.projects.models import Class, Task
from carve_api.projects.service import (
    _ADMIN_ROLES,
    _READ_ROLES,
    require_project_role,
)
from carve_api.storage.client import MinioClient


log = logging.getLogger(__name__)

DATASET_ROLLED_BACK = "dataset.rolled_back"

router = APIRouter(tags=["datasets"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


def _storage_or_none() -> Any:
    try:
        return MinioClient.from_settings()
    except Exception:  # noqa: BLE001
        return None


@router.get(
    "/projects/{project_id}/datasets",
    response_model=list[DatasetVersionOut],
)
def list_datasets(
    project_id: uuid.UUID,
    kind: str | None = None,
    task_id: uuid.UUID | None = None,
    before: datetime | None = None,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DatasetVersionOut]:
    try:
        require_project_role(db, user, project_id, _READ_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    rows = DatasetService.list_for_project(
        db,
        project_id,
        kind=kind,
        task_id=task_id,
        before=before,
        limit=limit,
    )
    # Outsourcing hardening — the storage key points at a full dataset
    # export bundle, so non-admins get the version history without it.
    # (The presigned download URL is withheld separately in
    # ``get_dataset``.)
    redact = not is_admin(user)
    return [DatasetVersionOut.from_orm_row(r, redact=redact) for r in rows]


@router.get(
    "/projects/{project_id}/datasets/{version_id}",
    response_model=DatasetVersionDetailOut,
)
def get_dataset(
    project_id: uuid.UUID,
    version_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DatasetVersionDetailOut:
    try:
        require_project_role(db, user, project_id, _READ_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    row = DatasetService.get(db, version_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="dataset_version_not_found")
    download_url: str | None = None
    # Outsourcing hardening — the presigned bundle URL is a full dataset
    # export. Non-admins keep the version metadata (so history and diffs
    # still read) but never receive a download link.
    if row.blob_key and is_admin(user):
        storage = _storage_or_none()
        if storage is not None:
            try:
                download_url = storage.presigned_get(
                    row.blob_key, expires_seconds=3600
                )
            except Exception:  # noqa: BLE001
                download_url = None
    base = DatasetVersionOut.from_orm_row(row, redact=not is_admin(user))
    return DatasetVersionDetailOut(**base.model_dump(), download_url=download_url)


def _load_bundle(storage, blob_key: str | None) -> bytes:
    if storage is None or not blob_key:
        return b""
    try:
        return storage.get_object(blob_key).read()
    except Exception:  # noqa: BLE001
        log.warning("dataset.differ: failed to fetch bundle %s", blob_key)
        return b""


@router.get(
    "/projects/{project_id}/datasets/{a_id}/diff/{b_id}",
    response_model=DatasetDiffOut,
)
def diff_datasets(
    project_id: uuid.UUID,
    a_id: uuid.UUID,
    b_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DatasetDiffOut:
    try:
        require_project_role(db, user, project_id, _READ_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    a = DatasetService.get(db, a_id)
    b = DatasetService.get(db, b_id)
    if a is None or a.project_id != project_id:
        raise HTTPException(status_code=404, detail="dataset_version_not_found")
    if b is None or b.project_id != project_id:
        raise HTTPException(status_code=404, detail="dataset_version_not_found")
    storage = _storage_or_none()
    zip_a = _load_bundle(storage, a.blob_key)
    zip_b = _load_bundle(storage, b.blob_key)
    diff: DatasetDiff = diff_bundles(zip_a, zip_b)
    return DatasetDiffOut(
        a_id=a.id,
        b_id=b.id,
        added=diff.added,
        removed=diff.removed,
        changed=diff.changed,
        by_image=[
            DatasetDiffByImage(**row) for row in diff.by_image
        ],
        summary_a=diff.summary_a,
        summary_b=diff.summary_b,
        note=diff.note,
    )


def _snapshot_task_annotations(
    db: Session, task: Task
) -> dict[str, list[dict[str, Any]]]:
    """Return ``{image_stem: [{class_idx, kind, geometry}, ...]}`` for the
    task's current annotations. Used to build rollback_pre/post snapshots
    so a rollback is itself reversible.
    """
    project_classes = list(
        db.execute(
            select(Class)
            .where(Class.project_id == task.project_id)
            .order_by(Class.idx)
        ).scalars()
    )
    class_id_to_idx = {c.id: i for i, c in enumerate(project_classes)}
    assets = {
        a.id: a
        for a in db.execute(
            select(Asset).where(Asset.task_id == task.id)
        ).scalars()
    }
    frame_to_asset = {
        f.id: f.asset_id
        for f in db.execute(
            select(Frame).where(Frame.asset_id.in_(list(assets)))
        ).scalars()
    }
    out: dict[str, list[dict[str, Any]]] = {}
    for ann in db.execute(
        select(Annotation).where(Annotation.task_id == task.id)
    ).scalars():
        if ann.frame_id is None:
            continue
        a_id = frame_to_asset.get(ann.frame_id)
        if a_id is None:
            continue
        asset = assets.get(a_id)
        if asset is None:
            continue
        stem = Path(asset.original_name).stem
        out.setdefault(stem, []).append({
            "class_idx": class_id_to_idx.get(ann.class_id, -1),
            "kind": ann.kind.value if hasattr(ann.kind, "value") else str(ann.kind),
            "geometry": dict(ann.geometry),
            "status": ann.status,
        })
    return out


def _summary_for_task(db: Session, task: Task) -> dict[str, Any]:
    anns = list(
        db.execute(
            select(Annotation).where(Annotation.task_id == task.id)
        ).scalars()
    )
    accepted = sum(1 for a in anns if a.status == "accepted")
    rejected = sum(1 for a in anns if a.status == "rejected")
    classes = list(
        db.execute(
            select(Class.name)
            .where(Class.project_id == task.project_id)
            .order_by(Class.idx)
        ).scalars()
    )
    asset_count = db.execute(
        select(Asset.id).where(Asset.task_id == task.id)
    ).scalars().all()
    return {
        "annotations": len(anns),
        "accepted": accepted,
        "rejected": rejected,
        "classes": classes,
        "asset_count": len(asset_count),
    }


@router.post(
    "/projects/{project_id}/datasets/{version_id}/rollback",
    response_model=RollbackOut,
)
def rollback_dataset(
    project_id: uuid.UUID,
    version_id: uuid.UUID,
    payload: RollbackIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RollbackOut:
    # Outsourcing hardening — rollback bulk-restores a stored snapshot
    # over live annotations, i.e. an import. Admin only.
    require_data_movement(user)
    try:
        require_project_role(db, user, project_id, _ADMIN_ROLES)
    except AppError as exc:
        raise _http(exc) from exc
    src = DatasetService.get(db, version_id)
    if src is None or src.project_id != project_id:
        raise HTTPException(status_code=404, detail="dataset_version_not_found")
    task = db.get(Task, payload.task_id)
    if task is None or task.project_id != project_id:
        raise HTTPException(status_code=404, detail="task_not_found")

    storage = _storage_or_none()
    bundle = _load_bundle(storage, src.blob_key)
    if not bundle:
        raise HTTPException(
            status_code=409, detail="dataset_bundle_unavailable"
        )

    # 1) snapshot the current state as rollback_pre.
    pre_snapshot = _snapshot_task_annotations(db, task)
    pre_summary = _summary_for_task(db, task)
    pre_summary["snapshot"] = pre_snapshot
    pre_version = DatasetService.register(
        db,
        project_id=project_id,
        task_id=task.id,
        kind="rollback_pre",
        source=str(version_id),
        created_by=user.id,
        label=(
            f"Rollback pre-state {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
        ),
        summary=pre_summary,
        blob_key=src.blob_key,
    )

    # 2) replace the task's annotations with the snapshot from src bundle.
    class_names, restored = parse_bundle_for_rollback(bundle)

    # Build asset stem -> asset map (for image dims) and class name -> id.
    assets = list(
        db.execute(select(Asset).where(Asset.task_id == task.id)).scalars()
    )
    stem_to_asset = {Path(a.original_name).stem: a for a in assets}
    asset_to_frame: dict[uuid.UUID, uuid.UUID] = {}
    for f in db.execute(
        select(Frame).where(Frame.asset_id.in_([a.id for a in assets]))
    ).scalars():
        asset_to_frame.setdefault(f.asset_id, f.id)
    project_classes = list(
        db.execute(
            select(Class).where(Class.project_id == task.project_id)
        ).scalars()
    )
    name_to_class = {c.name: c for c in project_classes}

    # Wipe existing annotations for the task.
    replaced_count = 0
    for ann in db.execute(
        select(Annotation).where(Annotation.task_id == task.id)
    ).scalars():
        db.delete(ann)
        replaced_count += 1
    db.flush()

    # Insert restored annotations.
    restored_count = 0
    for stem, items in restored.items():
        asset = stem_to_asset.get(stem)
        if asset is None or asset.width is None or asset.height is None:
            continue
        frame_id = asset_to_frame.get(asset.id)
        if frame_id is None:
            continue
        for item in items:
            cls_idx = item["class_idx"]
            if cls_idx < 0 or cls_idx >= len(class_names):
                continue
            cls = name_to_class.get(class_names[cls_idx])
            if cls is None:
                continue
            geom_norm = item["geometry_norm"]
            if item["kind"] == "bbox":
                cx = float(geom_norm["cx"]) * float(asset.width)
                cy = float(geom_norm["cy"]) * float(asset.height)
                w = float(geom_norm["w"]) * float(asset.width)
                h = float(geom_norm["h"]) * float(asset.height)
                geometry = {
                    "x": cx - w / 2.0,
                    "y": cy - h / 2.0,
                    "w": w,
                    "h": h,
                }
                kind = AnnotationKind.bbox
            elif item["kind"] == "polygon":
                pts = [
                    [
                        float(p[0]) * float(asset.width),
                        float(p[1]) * float(asset.height),
                    ]
                    for p in geom_norm["points"]
                ]
                geometry = {"points": pts}
                kind = AnnotationKind.polygon
            else:
                continue
            db.add(
                Annotation(
                    task_id=task.id,
                    frame_id=frame_id,
                    class_id=cls.id,
                    kind=kind,
                    geometry=geometry,
                    status="accepted",
                    created_by=user.id,
                )
            )
            restored_count += 1
    db.flush()

    # 3) snapshot the new state as rollback_post.
    post_summary = _summary_for_task(db, task)
    post_version = DatasetService.register(
        db,
        project_id=project_id,
        task_id=task.id,
        kind="rollback_post",
        source=str(version_id),
        created_by=user.id,
        label=(
            f"Rollback post-state {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
        ),
        summary=post_summary,
        blob_key=src.blob_key,
    )

    # 4) audit-log.
    audit_service.record(
        db,
        actor_id=user.id,
        action=DATASET_ROLLED_BACK,
        target_type="dataset_version",
        target_id=src.id,
        project_id=project_id,
        summary=(
            f"{DATASET_ROLLED_BACK} task={task.id} from={src.id} "
            f"replaced={replaced_count} restored={restored_count}"
        ),
        metadata={
            "from": str(src.id),
            "task_id": str(task.id),
            "replaced_count": replaced_count,
            "restored_count": restored_count,
        },
    )
    db.commit()

    return RollbackOut(
        pre_version_id=pre_version.id,
        post_version_id=post_version.id,
        replaced_count=replaced_count,
        restored_count=restored_count,
    )
