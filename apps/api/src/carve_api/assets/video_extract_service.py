# Armin Mehri — mehri.armin@gmail.com
"""Service layer for the video → image extraction batch endpoints.

HTTP-agnostic. Validates inputs, enqueues per-video RQ jobs, returns
typed responses. The router maps :class:`VideoExtractError` to 4xx
HTTPException.

Batch grouping uses two Redis namespaces:

* ``videoextract:batch:{batch_id}`` — a Redis SET of job ids belonging
  to one upload's batch.
* ``videoextract:asset:{asset_id}`` — a string with TTL whose presence
  flags the asset as being in an active (queued/running) job.

Per-job status + progress live in ``video-extract:{job_id}`` (managed by
``carve_api.jobs.video_to_images``).
"""
from __future__ import annotations

import os
import uuid

from sqlalchemy.orm import Session

from carve_api.assets.models import Asset, AssetKind
from carve_api.assets.video_extract_schemas import (
    BatchEnqueueIn,
    BatchEnqueueOut,
    BatchJobItem,
    BatchStatusOut,
)
from carve_api.jobs.video_to_images import (
    VideoToImagesPayload,
    get_progress,
    request_cancel,
    run_video_to_images,
)
from carve_api.projects.models import Task, TaskKind


_BATCH_SET_KEY = "videoextract:batch:{batch_id}"
_ACTIVE_ASSET_KEY = "videoextract:asset:{asset_id}"
_ACTIVE_TTL_SECONDS = 3600


class VideoExtractError(Exception):
    """Raised when a request can't be honored.

    The router converts these to HTTPExceptions using ``status_code``.
    """

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


# ---------------------------------------------------------------------------
# Redis client — small wrapper kept inline so tests can monkeypatch it.
# ---------------------------------------------------------------------------
def _redis():
    import redis as _redis_mod
    return _redis_mod.Redis(
        host=os.environ.get("REDIS_HOST", "redis"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
    )


def _batch_set_key(batch_id: uuid.UUID) -> str:
    return _BATCH_SET_KEY.format(batch_id=batch_id)


def _active_asset_key(asset_id: uuid.UUID) -> str:
    return _ACTIVE_ASSET_KEY.format(asset_id=asset_id)


def _add_to_batch_set(batch_id: uuid.UUID, job_id: str) -> None:
    r = _redis()
    r.sadd(_batch_set_key(batch_id), job_id)
    r.expire(_batch_set_key(batch_id), _ACTIVE_TTL_SECONDS)


def _batch_job_ids(batch_id: uuid.UUID) -> list[str]:
    r = _redis()
    members = r.smembers(_batch_set_key(batch_id)) or set()
    return sorted(m.decode() if isinstance(m, bytes) else m for m in members)


def _mark_asset_active(asset_id: uuid.UUID, job_id: str) -> None:
    r = _redis()
    r.set(_active_asset_key(asset_id), job_id, ex=_ACTIVE_TTL_SECONDS)


def _is_in_active_extraction(asset_id: uuid.UUID) -> bool:
    r = _redis()
    return bool(r.get(_active_asset_key(asset_id)))


def _enqueue(payload: VideoToImagesPayload) -> str:
    """Submit the job to the RQ default queue. Returns the RQ job id.

    Pre-allocates ``payload.job_id`` and forwards it as the RQ ``job_id``
    kwarg so the same identifier appears in our Redis progress hash AND
    in RQ's own job registry. Tests monkeypatch this function.
    """
    from carve_api.jobs.queue import enqueue_with_defaults
    enqueue_with_defaults(
        run_video_to_images, payload, kind="low", job_id=payload.job_id
    )
    return payload.job_id


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def enqueue_batch(
    db: Session, *, task: Task, payload: BatchEnqueueIn
) -> BatchEnqueueOut:
    """Validate then enqueue one RQ job per source video."""
    if task.kind != TaskKind.image:
        raise VideoExtractError("must be invoked on an image-kind task")

    assets = (
        db.query(Asset)
        .filter(Asset.id.in_(payload.source_asset_ids))
        .all()
    )
    by_id = {a.id: a for a in assets}
    for src_id in payload.source_asset_ids:
        a = by_id.get(src_id)
        if a is None or a.task_id != task.id:
            raise VideoExtractError(f"asset {src_id} not in this task")
        if a.kind != AssetKind.video:
            raise VideoExtractError(f"asset {src_id} is not a video")
        if _is_in_active_extraction(a.id):
            raise VideoExtractError(
                f"asset {src_id} already queued/running",
                status_code=409,
            )

    batch_id = uuid.uuid4()
    items: list[BatchJobItem] = []
    for src_id in payload.source_asset_ids:
        a = by_id[src_id]
        job_id = f"vti-{uuid.uuid4()}"
        vti_payload = VideoToImagesPayload(
            job_id=job_id,
            batch_id=str(batch_id),
            task_id=str(task.id),
            source_asset_id=str(src_id),
            mode=payload.mode,
            n_or_k=payload.n_or_k,
            quality=payload.quality,
            source_filename=a.original_name,
        )
        _enqueue(vti_payload)
        _add_to_batch_set(batch_id, job_id)
        _mark_asset_active(a.id, job_id)
        items.append(
            BatchJobItem(
                job_id=job_id,
                source_asset_id=src_id,
                source_filename=a.original_name,
                status="queued",
                progress=0,
                frames_extracted=0,
                dedup_skipped=0,
                error_message=None,
            )
        )
    return BatchEnqueueOut(batch_id=batch_id, jobs=items)


def get_batch_status(*, task: Task, batch_id: uuid.UUID) -> BatchStatusOut:
    job_ids = _batch_job_ids(batch_id)
    if not job_ids:
        raise VideoExtractError("batch not found", status_code=404)

    items: list[BatchJobItem] = []
    for jid in job_ids:
        meta = get_progress(jid) or {}
        # Defensive defaults: an empty meta (e.g. before the worker
        # writes the first hash) still surfaces as a ``queued`` row.
        source_asset_id_raw = meta.get("source_asset_id") or ""
        try:
            source_asset_id = (
                uuid.UUID(source_asset_id_raw)
                if source_asset_id_raw
                else uuid.UUID(int=0)
            )
        except ValueError:
            source_asset_id = uuid.UUID(int=0)
        progress = _safe_int(meta.get("progress"), default=0, clamp_max=100)
        items.append(
            BatchJobItem(
                job_id=jid,
                source_asset_id=source_asset_id,
                source_filename=meta.get("source_filename") or "",
                status=_safe_status(meta.get("status")),
                progress=progress,
                frames_extracted=_safe_int(meta.get("frames_extracted")),
                dedup_skipped=_safe_int(meta.get("dedup_skipped")),
                error_message=(meta.get("error_message") or None) or None,
            )
        )
    return BatchStatusOut(batch_id=batch_id, jobs=items)


def cancel_batch(*, task: Task, batch_id: uuid.UUID) -> None:
    job_ids = _batch_job_ids(batch_id)
    if not job_ids:
        raise VideoExtractError("batch not found", status_code=404)
    for jid in job_ids:
        meta = get_progress(jid) or {}
        status = _safe_status(meta.get("status"))
        if status in ("succeeded", "failed", "cancelled"):
            continue
        request_cancel(jid)
        # Queued jobs that haven't started: surface the cancellation in
        # the API immediately so the UI doesn't sit at ``queued`` forever.
        if status == "queued":
            from carve_api.jobs.video_to_images import set_progress
            set_progress(jid, {"status": "cancelled"})


def _safe_int(raw, default: int = 0, *, clamp_max: int | None = None) -> int:  # type: ignore[no-untyped-def]
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    if clamp_max is not None and v > clamp_max:
        return clamp_max
    if v < 0:
        return 0
    return v


_VALID_STATUSES = {"queued", "running", "succeeded", "failed", "cancelled"}


def _safe_status(raw):  # type: ignore[no-untyped-def]
    if raw in _VALID_STATUSES:
        return raw
    return "queued"
