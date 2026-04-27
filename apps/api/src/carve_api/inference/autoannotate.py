"""Single-image auto-annotate orchestration."""

import base64
import uuid

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.model_client import ModelServiceError, yolo_load, yolo_predict
from carve_api.projects.models import Class, Task
from carve_api.storage.client import MinioClient
from carve_api.weights.models import Weight


class AutoAnnotateMismatch(AppError):
    http_status = 400
    code = "weight_project_mismatch"


class AutoAnnotateModelFailed(AppError):
    http_status = 502
    code = "model_service_failed"


class AutoAnnotateModelUnreachable(AppError):
    """Model service is offline (DNS/connect/timeout)."""

    http_status = 503
    code = "model_service_unreachable"


def _index_classes_by_lower_name(classes: list[Class]) -> dict[str, uuid.UUID]:
    return {c.name.lower(): c.id for c in classes}


def _resolve_frame_id(session: Session, asset: Asset) -> uuid.UUID | None:
    """Return the asset's first Frame id (idx=0) if present.

    Image assets always have exactly one Frame at idx=0 (created at upload).
    Video assets may have many — we use frame 0 here as the default for now.
    """
    row = session.execute(
        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()
    return row.id if row else None


def auto_annotate_asset(
    *,
    session: Session,
    actor: User,
    task: Task,
    asset: Asset,
    weight: Weight,
    overwrite: bool,
    presigned_url_for_weight: str,
    image_bytes: bytes,
) -> list[Annotation]:
    if weight.project_id != task.project_id:
        raise AutoAnnotateMismatch("weight does not belong to this project")

    classes = list(
        session.execute(select(Class).where(Class.project_id == task.project_id)).scalars()
    )
    classes_by_name = _index_classes_by_lower_name(classes)

    # Load weight on the model service (idempotent via LRU)
    try:
        yolo_load(str(weight.id), presigned_url_for_weight)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise AutoAnnotateModelUnreachable(f"yolo/load: {exc.body!r}") from exc
        raise AutoAnnotateModelFailed(f"yolo/load: {exc.body!r}") from exc

    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    try:
        result = yolo_predict(str(weight.id), image_b64)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise AutoAnnotateModelUnreachable(f"yolo/predict: {exc.body!r}") from exc
        raise AutoAnnotateModelFailed(f"yolo/predict: {exc.body!r}") from exc

    frame_id = _resolve_frame_id(session, asset)
    if overwrite and frame_id is not None:
        session.execute(
            sa_delete(Annotation).where(
                Annotation.task_id == task.id,
                Annotation.frame_id == frame_id,
            )
        )

    created: list[Annotation] = []
    for det in result.get("detections", []):
        cls_id = classes_by_name.get(str(det.get("class_name", "")).lower())
        if cls_id is None:
            continue
        b = det["bbox"]
        ann = Annotation(
            task_id=task.id,
            frame_id=frame_id,
            class_id=cls_id,
            kind=AnnotationKind.bbox,
            geometry={"kind": "bbox", "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"]},
            track_id=None,
            created_by=actor.id,
        )
        session.add(ann)
        created.append(ann)

    for poly in result.get("polygons", []):
        cls_id = classes_by_name.get(str(poly.get("class_name", "")).lower())
        if cls_id is None:
            continue
        pts = [[float(p[0]), float(p[1])] for p in poly.get("points", [])]
        if len(pts) < 3:
            continue
        ann = Annotation(
            task_id=task.id,
            frame_id=frame_id,
            class_id=cls_id,
            kind=AnnotationKind.polygon,
            geometry={"kind": "polygon", "points": pts},
            track_id=None,
            created_by=actor.id,
        )
        session.add(ann)
        created.append(ann)

    session.flush()
    return created


def fetch_asset_bytes(asset: Asset) -> bytes:
    """Read the asset's original bytes from MinIO."""
    storage = MinioClient.from_settings()
    ext = asset.original_name.rsplit(".", 1)[-1] if "." in asset.original_name else "bin"
    body = storage.get_object(f"assets/{asset.xxh3_128}/original.{ext}").read()
    return body


def presigned_url_for_weight(weight: Weight) -> str:
    storage = MinioClient.from_settings()
    return storage.presigned_get(weight.minio_key, expires_seconds=600)
