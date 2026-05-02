"""Active-learning retrain RQ job (plan-09 task-05).

Pipeline:
  1. Export the task's accepted (and optionally proposed) annotations into
     a YOLO dataset zip (via :mod:`carve_api.io.yolo_out`).
  2. Upload the zip to MinIO at ``retrain/<task_id>/<job_id>/dataset.zip``.
  3. Call the model service's ``/yolo/train`` endpoint with a 4h presigned
     internal URL pointing at the dataset.
  4. Register the produced ``best.pt`` as a new project-scoped ``Weight``
     row using the descriptor returned by the model service.

Progress is mirrored to Redis hash ``retrain:job:<job_id>`` with the
following string fields:

  * ``phase``           one of {exporting, uploading_dataset, training,
                                registering, done, error}
  * ``progress_pct``    integer 0..100 (best-effort phase boundaries)
  * ``error``           short error code on failure, else empty string
  * ``error_traceback`` last few traceback lines, else empty string
  * ``weight_id``       new Weight row id on success, else empty string

Plan-09b Task 5 -- the ``Weight.metadata_`` JSONB column is now populated
on retrain registration with::

    {"retrain": {"task_id": ..., "epochs": ..., "imgsz": ...,
                 "include_proposed": ..., "metrics": <dict>,
                 "trained_at": "<utcnow().isoformat()>"}}

The metrics dict is whatever the model service's ``/yolo/train`` returns
under the ``metrics`` key.
"""

from __future__ import annotations

import io
import logging
import traceback
import uuid
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session


log = logging.getLogger(__name__)


_PROGRESS_KEY_PREFIX = "retrain:job:"
_PROGRESS_TTL_SECONDS = 24 * 3600
_DATASET_PRESIGN_TTL_S = 4 * 3600  # 4h — covers slow trains


def progress_key(job_id: str) -> str:
    return f"{_PROGRESS_KEY_PREFIX}{job_id}"


@dataclass
class RetrainJobPayload:
    """RQ-pickled args for the retrain job."""

    job_id: str
    actor_id: str
    task_id: str
    base_weight_id: str | None
    epochs: int
    imgsz: int
    include_proposed: bool
    weight_name: str | None


def build_payload(
    *,
    actor_id: uuid.UUID,
    task_id: uuid.UUID,
    base_weight_id: uuid.UUID | None,
    epochs: int,
    imgsz: int,
    include_proposed: bool,
    weight_name: str | None,
) -> RetrainJobPayload:
    return RetrainJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor_id),
        task_id=str(task_id),
        base_weight_id=str(base_weight_id) if base_weight_id else None,
        epochs=int(epochs),
        imgsz=int(imgsz),
        include_proposed=bool(include_proposed),
        weight_name=weight_name,
    )


# ---------------------------------------------------------------------------
# Redis progress helpers
# ---------------------------------------------------------------------------


def _set_phase(
    redis_client,
    job_id: str,
    *,
    phase: str,
    progress_pct: int,
    error: str = "",
    error_traceback: str = "",
    weight_id: str = "",
) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(
            progress_key(job_id),
            mapping={
                "phase": phase,
                "progress_pct": str(int(progress_pct)),
                "error": error,
                "error_traceback": error_traceback,
                "weight_id": weight_id,
            },
        )
        redis_client.expire(progress_key(job_id), _PROGRESS_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        pass


def read_progress(redis_client, job_id: str) -> dict | None:
    """Return the Redis hash for ``job_id`` or ``None`` if absent."""
    if redis_client is None:
        return None
    try:
        raw = redis_client.hgetall(progress_key(job_id))
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None

    # Both producers (run_retrain_job worker) and consumers
    # (retrain_router) build their Redis client with ``decode_responses=True``
    # so values come back as ``str`` already. No bytes coercion needed.
    parsed = dict(raw)
    try:
        progress_pct = int(parsed.get("progress_pct", "0"))
    except ValueError:
        progress_pct = 0
    return {
        "phase": parsed.get("phase", "unknown"),
        "progress_pct": progress_pct,
        "error": parsed.get("error") or None,
        "error_traceback": parsed.get("error_traceback") or None,
        "weight_id": parsed.get("weight_id") or None,
    }


# ---------------------------------------------------------------------------
# Dataset export — YOLO zip in memory
# ---------------------------------------------------------------------------


def _build_dataset_zip(
    *,
    session: Session,
    storage,
    task,  # carve_api.projects.models.Task
    include_proposed: bool,
) -> tuple[bytes, list[str]]:
    """Export the task's annotations into a YOLO dataset zip.

    Returns ``(zip_bytes, class_names)``. Filters annotations by status:
    always includes ``accepted``; includes ``proposed`` when
    ``include_proposed`` is true. Rejected annotations are never exported.
    """
    from carve_api.annotations.models import Annotation
    from carve_api.assets.models import Asset, AssetKind, Frame
    from carve_api.io.yolo_out import RemapTarget, write_data_yaml, write_yolo_label
    from carve_api.projects.models import Class

    statuses_kept = {"accepted"}
    if include_proposed:
        statuses_kept.add("proposed")

    # Resolve effective classes for this task (snapshot or full project list).
    project_classes = list(
        session.execute(
            select(Class)
            .where(Class.project_id == task.project_id)
            .order_by(Class.idx)
        ).scalars()
    )
    if task.allowed_class_ids is not None:
        allowed = set(task.allowed_class_ids)
        effective = [c for c in project_classes if c.id in allowed]
    else:
        effective = project_classes

    # Densify class indices to 0..N-1 — the YOLO data.yaml ``names`` array is
    # contiguous and label files reference it by integer index, so we MUST
    # remap project ``idx`` (which is sparse if classes were deleted) to a
    # dense sequence. Mirrors the export path's ``_densify_remap``.
    remap: dict[str, dict[str, Any]] = {}
    targets: list[RemapTarget] = []
    for export_id, c in enumerate(effective):
        remap[str(c.id)] = {"export_id": export_id, "name": str(c.name)}
        targets.append(RemapTarget(export_id=export_id, name=str(c.name)))

    class_names = [t.name for t in targets]

    # Load assets + frame map + status-filtered annotations.
    assets = list(
        session.execute(select(Asset).where(Asset.task_id == task.id)).scalars()
    )
    asset_ids = [a.id for a in assets]
    frame_to_asset: dict[uuid.UUID, uuid.UUID] = {
        row.id: row.asset_id
        for row in session.execute(
            select(Frame).where(Frame.asset_id.in_(asset_ids))
        ).scalars()
    }
    ann_rows = list(
        session.execute(
            select(Annotation).where(Annotation.task_id == task.id)
        ).scalars()
    )
    anns_by_asset: dict[uuid.UUID, list[Annotation]] = defaultdict(list)
    for ann in ann_rows:
        if ann.status not in statuses_kept:
            continue
        if ann.frame_id is None:
            continue
        a_id = frame_to_asset.get(ann.frame_id)
        if a_id is not None:
            anns_by_asset[a_id].append(ann)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for asset in assets:
            if asset.width is None or asset.height is None:
                continue
            anns = anns_by_asset.get(asset.id, [])
            lines, _warnings = write_yolo_label(
                anns,
                remap=remap,
                image_w=int(asset.width),
                image_h=int(asset.height),
            )
            stem = Path(asset.original_name).stem
            zf.writestr(
                f"labels/train/{stem}.txt",
                ("\n".join(lines) + "\n") if lines else "",
            )
            if asset.kind == AssetKind.image:
                ext = Path(asset.original_name).suffix.lstrip(".") or "bin"
                try:
                    body = storage.get_object(
                        f"assets/{asset.xxh3_128}/original.{ext}"
                    ).read()
                except Exception:  # noqa: BLE001
                    continue
                zf.writestr(f"images/train/{asset.original_name}", body)
        zf.writestr(
            "data.yaml",
            write_data_yaml(
                targets=targets,
                splits={"train": "images/train", "val": "images/train"},
            ),
        )

    return buf.getvalue(), class_names


# ---------------------------------------------------------------------------
# Weight registration after train
# ---------------------------------------------------------------------------


def _register_trained_weight(
    *,
    session: Session,
    task,
    actor_id: uuid.UUID,
    descriptor: dict,
    weight_name: str | None,
    class_names: list[str],
    payload: "RetrainJobPayload | None" = None,
) -> "uuid.UUID":
    """Insert a new ``Weight`` row pointing at the model service's already-
    uploaded blob. The model service has already computed the xxh3_128 and
    uploaded to ``weights/<xxh3>/<new_weight_id>.pt`` so we just record
    metadata.

    Plan-09b Task 5 -- the trainer's metrics dict + the retrain
    hyperparameters are persisted on ``Weight.metadata_`` so audit /
    comparison flows can introspect a weight's training context. The
    ``payload`` kwarg is optional only to keep the function backward-
    compatible with any direct test caller; production callers
    (``retrain_job``) always pass it.
    """
    from carve_api.weights.models import Weight, WeightTaskKind

    xxh = str(descriptor["xxh3_128"])
    new_weight_external_id = str(descriptor["weight_id"])
    minio_key = f"weights/{xxh}/{new_weight_external_id}.pt"
    name = (weight_name or f"retrain-{task.name}-{new_weight_external_id[:8]}")[:120]

    metadata: dict | None = None
    if payload is not None:
        metadata = {
            "retrain": {
                "task_id": payload.task_id,
                "epochs": int(payload.epochs),
                "imgsz": int(payload.imgsz),
                "include_proposed": bool(payload.include_proposed),
                "metrics": dict(descriptor.get("metrics") or {}),
                "trained_at": datetime.now(timezone.utc).isoformat(),
            }
        }

    w = Weight(
        id=uuid.uuid4(),
        project_id=task.project_id,
        name=name,
        task_kind=WeightTaskKind.detect,
        minio_key=minio_key,
        size_bytes=int(descriptor.get("size_bytes", 0) or 0),
        class_names=list(class_names or []),
        created_by=actor_id,
        metadata_=metadata,
    )
    session.add(w)
    session.flush()
    log.info(
        "retrain.registered weight_id=%s task_id=%s minio_key=%s metrics=%s",
        w.id,
        task.id,
        minio_key,
        descriptor.get("metrics"),
    )
    return w.id


# ---------------------------------------------------------------------------
# Job entry point (importable directly for tests; bypasses RQ)
# ---------------------------------------------------------------------------


def retrain_job(
    payload: RetrainJobPayload,
    *,
    session: Session | None = None,
    storage=None,
    redis_client=None,
) -> dict:
    """Run the retrain pipeline.

    The ``session`` / ``storage`` / ``redis_client`` overrides exist so
    the test harness can drive the pipeline against a transactional test
    DB and a fake storage. In production, the RQ wrapper below opens its
    own session + storage + Redis client.
    """
    from carve_api.inference import model_client
    from carve_api.projects.models import Task

    job_id = payload.job_id
    task_uuid = uuid.UUID(payload.task_id)
    actor_uuid = uuid.UUID(payload.actor_id)

    # Phase 1 — export
    _set_phase(redis_client, job_id, phase="exporting", progress_pct=5)
    try:
        task = session.get(Task, task_uuid) if session is not None else None
        if task is None:
            _set_phase(
                redis_client,
                job_id,
                phase="error",
                progress_pct=0,
                error="task_not_found",
            )
            return {"ok": False, "error": "task_not_found"}

        zip_bytes, class_names = _build_dataset_zip(
            session=session,
            storage=storage,
            task=task,
            include_proposed=payload.include_proposed,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("retrain.export.failed job_id=%s", job_id)
        _set_phase(
            redis_client,
            job_id,
            phase="error",
            progress_pct=0,
            error=f"export_failed: {exc}",
            error_traceback=traceback.format_exc(),
        )
        return {"ok": False, "error": "export_failed"}

    # Phase 2 — upload dataset zip to MinIO
    _set_phase(
        redis_client, job_id, phase="uploading_dataset", progress_pct=20
    )
    dataset_key = f"retrain/{task_uuid}/{job_id}/dataset.zip"
    try:
        storage.ensure_bucket()
        storage.put_object(
            dataset_key,
            io.BytesIO(zip_bytes),
            len(zip_bytes),
            "application/zip",
        )
        dataset_url = storage.presigned_get_internal(
            dataset_key, expires_seconds=_DATASET_PRESIGN_TTL_S
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("retrain.upload.failed job_id=%s", job_id)
        _set_phase(
            redis_client,
            job_id,
            phase="error",
            progress_pct=0,
            error=f"dataset_upload_failed: {exc}",
            error_traceback=traceback.format_exc(),
        )
        return {"ok": False, "error": "dataset_upload_failed"}

    # Phase 3 — train (long-running model-service call)
    _set_phase(redis_client, job_id, phase="training", progress_pct=40)
    try:
        # If a base weight was specified, materialise it into the model
        # service's LRU before train starts. Otherwise the model only
        # resolves ``weight_id_base`` from its in-process cache and would
        # silently fall back to ``yolov8n.pt`` if the user-supplied base
        # hasn't been recently loaded.
        # plan-09 task-09 — wrap each single model-service call in
        # run_with_retry so a 503 (model_service_unreachable) during
        # warmup doesn't blow up an otherwise-valid retrain.
        from carve_api.jobs.retry import run_with_retry

        if payload.base_weight_id:
            from carve_api.inference.autoannotate import presigned_url_for_weight
            from carve_api.weights.models import Weight

            base_weight = session.get(
                Weight, uuid.UUID(payload.base_weight_id)
            )
            if base_weight is not None:
                base_url = presigned_url_for_weight(base_weight)
                run_with_retry(
                    model_client.yolo_load, payload.base_weight_id, base_url
                )
        descriptor = run_with_retry(
            model_client.yolo_train,
            weight_id_base=payload.base_weight_id,
            dataset_zip_url=dataset_url,
            epochs=payload.epochs,
            imgsz=payload.imgsz,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("retrain.train.failed job_id=%s", job_id)
        _set_phase(
            redis_client,
            job_id,
            phase="error",
            progress_pct=0,
            error=f"train_failed: {exc}",
            error_traceback=traceback.format_exc(),
        )
        return {"ok": False, "error": "train_failed"}

    # Phase 4 — register the new Weight row
    _set_phase(redis_client, job_id, phase="registering", progress_pct=90)
    from carve_api.audit import service as _audit
    from carve_api.audit.actions import RETRAIN_COMPLETED, RETRAIN_FAILED

    try:
        new_weight_id = _register_trained_weight(
            session=session,
            task=task,
            actor_id=actor_uuid,
            descriptor=descriptor,
            weight_name=payload.weight_name,
            class_names=class_names,
            payload=payload,
        )
        # Plan-13 Phase 7 Task 3 — best-effort audit on completion.
        # Recorded BEFORE commit so the audit row joins the same tx as
        # the new Weight; if either fails the rollback below covers both.
        _audit.record(
            session,
            actor_id=actor_uuid,
            action=RETRAIN_COMPLETED,
            target_type="retrain_job",
            target_id=None,
            project_id=task.project_id,
            summary=(
                f"{RETRAIN_COMPLETED} task={task.id} "
                f"weight={new_weight_id}"
            ),
            metadata={
                "job_id": job_id,
                "task_id": str(task.id),
                "weight_id": str(new_weight_id),
                "metrics": dict(descriptor.get("metrics") or {}),
            },
        )
        session.commit()
    except Exception as exc:  # noqa: BLE001
        log.exception("retrain.register.failed job_id=%s", job_id)
        try:
            session.rollback()
        except Exception:  # noqa: BLE001
            pass
        _set_phase(
            redis_client,
            job_id,
            phase="error",
            progress_pct=0,
            error=f"register_failed: {exc}",
            error_traceback=traceback.format_exc(),
        )
        # Plan-13 Phase 7 Task 3 — best-effort failure audit on a fresh
        # tx so the rolled-back register doesn't drag the audit row down.
        try:
            _audit.record(
                session,
                actor_id=actor_uuid,
                action=RETRAIN_FAILED,
                target_type="retrain_job",
                target_id=None,
                project_id=task.project_id if task is not None else None,
                summary=f"{RETRAIN_FAILED} task={payload.task_id} job={job_id}",
                metadata={
                    "job_id": job_id,
                    "task_id": payload.task_id,
                    "error": str(exc),
                },
            )
            session.commit()
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": "register_failed"}

    _set_phase(
        redis_client,
        job_id,
        phase="done",
        progress_pct=100,
        weight_id=str(new_weight_id),
    )
    return {
        "ok": True,
        "weight_id": str(new_weight_id),
        "metrics": descriptor.get("metrics", {}),
    }


def run_retrain_job(payload: RetrainJobPayload) -> dict:
    """RQ entry point — opens its own session/storage/Redis."""
    import os

    import redis as _redis

    from carve_api.config import get_settings
    from carve_api.db import get_session_factory
    from carve_api.storage.client import MinioClient

    settings = get_settings()
    redis_client = None
    try:
        redis_client = _redis.Redis(
            host=os.environ.get("REDIS_HOST", settings.redis_host),
            port=int(os.environ.get("REDIS_PORT", settings.redis_port)),
            decode_responses=True,
        )
    except Exception:  # noqa: BLE001
        log.exception("retrain: redis init failed; running without progress")

    SessionLocal = get_session_factory()
    storage = MinioClient.from_settings()
    session = SessionLocal()
    try:
        return retrain_job(
            payload,
            session=session,
            storage=storage,
            redis_client=redis_client,
        )
    finally:
        session.close()
