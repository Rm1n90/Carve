"""Annotation import RQ job.

Pipeline:
  1. Read the archive bytes from MinIO at imports/<task_id>/<import_id>.<ext>.
  2. Build a (filename → asset) map from the task's assets.
  3. Build a (basename → (w, h)) map from those assets.
  4. Parse the archive (YOLO or COCO).
  5. Resolve class names case-insensitively against the project's classes.
  6. Insert Annotation rows for every matched draft; warn for misses.
  7. Update Redis progress + final status.
  8. Delete the staged archive.
"""

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select

from vaa_api.annotations.models import Annotation
from vaa_api.assets.models import Asset, Frame
from vaa_api.io.coco_in import parse_coco_bytes
from vaa_api.io.yolo_in import AnnotationDraft, ParsedArchive, parse_yolo_archive
from vaa_api.projects.models import Class, Task


_IMP_KEY_PREFIX = "imp:job:"
_IMP_TTL_SECONDS = 24 * 3600


def progress_key(job_id: str) -> str:
    return f"{_IMP_KEY_PREFIX}{job_id}"


@dataclass
class ImportJobPayload:
    job_id: str
    actor_id: str
    task_id: str
    import_id: str
    minio_key: str
    fmt: str  # "yolo" | "coco"


def init_progress(redis_client, job_id: str, total: int) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), mapping={
            "status": "running",
            "done": "0",
            "total": str(total),
            "warnings": "[]",
        })
        redis_client.expire(progress_key(job_id), _IMP_TTL_SECONDS)
    except Exception:
        pass


def update_progress(redis_client, job_id: str, *, done: int, warnings: list[str]) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), mapping={
            "done": str(done),
            "warnings": json.dumps(warnings[-200:]),
        })
    except Exception:
        pass


def finalize_progress(redis_client, job_id: str, *, status: str) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), "status", status)
    except Exception:
        pass


def read_progress(redis_client, job_id: str) -> dict:
    default = {"status": "pending", "done": 0, "total": 0, "warnings": []}
    if redis_client is None:
        return default
    try:
        raw = redis_client.hgetall(progress_key(job_id))
    except Exception:
        return default
    if not raw:
        return default

    def _b2s(v):
        return v.decode() if isinstance(v, bytes) else v

    parsed = {_b2s(k): _b2s(v) for k, v in raw.items()}
    try:
        warnings = json.loads(parsed.get("warnings", "[]"))
    except json.JSONDecodeError:
        warnings = []
    return {
        "status": parsed.get("status", "pending"),
        "done": int(parsed.get("done", 0)),
        "total": int(parsed.get("total", 0)),
        "warnings": warnings,
    }


def _build_dim_map(assets: list[Asset]) -> dict[str, tuple[int, int]]:
    """Return {basename_with_ext, basename_stem} → (w, h)."""
    out: dict[str, tuple[int, int]] = {}
    for a in assets:
        if a.width is None or a.height is None:
            continue
        full = a.original_name
        stem = Path(full).stem
        dims = (int(a.width), int(a.height))
        out.setdefault(full, dims)
        out.setdefault(stem, dims)
    return out


def _build_asset_map(assets: list[Asset]) -> dict[str, Asset]:
    """Return {basename, basename_stem (lowercased)} → asset."""
    out: dict[str, Asset] = {}
    for a in assets:
        full = a.original_name
        stem = Path(full).stem
        out.setdefault(full.lower(), a)
        out.setdefault(stem.lower(), a)
    return out


def _build_class_map(classes: list[Class]) -> dict[str, uuid.UUID]:
    return {c.name.lower(): c.id for c in classes}


def _resolve_frame_id(session, asset: Asset) -> uuid.UUID | None:
    row = session.execute(
        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
    ).scalar_one_or_none()
    return row.id if row else None


def import_drafts(
    *,
    session,
    actor_id: uuid.UUID,
    task: Task,
    drafts: list[AnnotationDraft],
    classes_by_lower_name: dict[str, uuid.UUID],
    assets_by_filename: dict[str, Asset],
) -> tuple[int, list[str]]:
    """Insert Annotation rows for every matched draft. Returns (created_count, warnings).

    Pure DB function — no Redis here so it's easy to unit-test.
    """
    warnings: list[str] = []
    created = 0
    for d in drafts:
        asset = (
            assets_by_filename.get(d.image_filename.lower())
            or assets_by_filename.get(f"{d.image_filename}.png".lower())
            or assets_by_filename.get(f"{d.image_filename}.jpg".lower())
            or assets_by_filename.get(f"{d.image_filename}.jpeg".lower())
        )
        if asset is None:
            warnings.append(f"no asset matched filename {d.image_filename!r}")
            continue
        cls_id = classes_by_lower_name.get(d.class_name.lower())
        if cls_id is None:
            warnings.append(f"no project class matched {d.class_name!r}")
            continue
        frame_id = _resolve_frame_id(session, asset)
        ann = Annotation(
            task_id=task.id,
            frame_id=frame_id,
            class_id=cls_id,
            kind=d.kind,
            geometry=d.geometry,
            track_id=None,
            created_by=actor_id,
        )
        session.add(ann)
        created += 1
    session.flush()
    return created, warnings


def run_import_job(payload: ImportJobPayload) -> dict:
    """RQ entry point. Imports kept inside the function so workers without
    a full app preload can still pickle this module."""
    from redis import Redis

    from vaa_api.config import get_settings
    from vaa_api.db import get_session_factory
    from vaa_api.storage.client import MinioClient

    settings = get_settings()
    try:
        redis_client = Redis(host=settings.redis_host, port=settings.redis_port)
    except Exception:
        redis_client = None

    storage = MinioClient.from_settings()
    SessionLocal = get_session_factory()

    with SessionLocal.begin() as session:
        task = session.get(Task, uuid.UUID(payload.task_id))
        if task is None:
            init_progress(redis_client, payload.job_id, 0)
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"status": "failed", "reason": "task_not_found"}

        # Project classes for resolution
        classes = list(
            session.execute(select(Class).where(Class.project_id == task.project_id)).scalars()
        )
        class_map = _build_class_map(classes)

        # Task assets for filename + dims resolution
        assets = list(
            session.execute(select(Asset).where(Asset.task_id == task.id)).scalars()
        )
        asset_map = _build_asset_map(assets)
        dim_map = _build_dim_map(assets)

        try:
            archive_bytes = storage.get_object(payload.minio_key).read()
        except Exception as exc:  # noqa: BLE001
            init_progress(redis_client, payload.job_id, 0)
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"status": "failed", "reason": f"download_failed: {exc!r}"}

        try:
            if payload.fmt == "yolo":
                parsed: ParsedArchive = parse_yolo_archive(
                    archive_bytes, image_dimensions=dim_map,
                )
            elif payload.fmt == "coco":
                parsed = parse_coco_bytes(archive_bytes)
            else:
                init_progress(redis_client, payload.job_id, 0)
                finalize_progress(redis_client, payload.job_id, status="failed")
                return {"status": "failed", "reason": f"unsupported_format: {payload.fmt}"}
        except Exception as exc:  # noqa: BLE001
            init_progress(redis_client, payload.job_id, 0)
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"status": "failed", "reason": f"parse_failed: {exc!r}"}

        init_progress(redis_client, payload.job_id, len(parsed.drafts))
        warnings = list(parsed.warnings)
        actor_uuid = uuid.UUID(payload.actor_id)
        created, more_warnings = import_drafts(
            session=session,
            actor_id=actor_uuid,
            task=task,
            drafts=parsed.drafts,
            classes_by_lower_name=class_map,
            assets_by_filename=asset_map,
        )
        warnings.extend(more_warnings)
        update_progress(redis_client, payload.job_id, done=created, warnings=warnings)

    # Best-effort cleanup of the staged archive
    try:
        storage.remove_object(payload.minio_key)
    except Exception:
        pass

    final_status = "completed" if not warnings else "completed_with_warnings"
    finalize_progress(redis_client, payload.job_id, status=final_status)
    return {"status": final_status, "done": created, "warnings": warnings}
