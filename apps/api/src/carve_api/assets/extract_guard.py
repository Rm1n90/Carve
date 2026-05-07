# Armin Mehri — mehri.armin@gmail.com
"""Frame-extraction idempotency guard.

Used by ``POST /assets/{id}/frames/extract`` to avoid racing two
workers against the same MinIO prefix when a user double-clicks the
Re-extract button (or the upload-time auto-kick lands on top of an
already-running extract).

The Redis hash at ``frame-extract:{asset_id}`` is written by the
worker in ``carve_api.jobs.frames.extract_frames_for_video``.
Shape: ``{status, phase, decoded, expected, uploaded, job_id, ...}``.
"""
from __future__ import annotations

from typing import Any


def check_extract_idempotency(
    redis_client: Any,
    asset_id: str,
) -> str | None:
    """Look up the in-flight extract for ``asset_id`` and decide what to do.

    Returns:
        - existing job_id (str) if an alive RQ job is running for this
          asset; the caller should respond 409 with this id so the
          client can attach to it instead of enqueueing a duplicate.
        - None if there is no running extract (or the marker was stale
          and has been cleared); the caller is free to enqueue a fresh
          job.
    """
    progress_key = f"frame-extract:{asset_id}"
    existing = redis_client.hgetall(progress_key) or {}
    if existing.get("status") != "running":
        return None

    existing_job_id = existing.get("job_id")
    if not existing_job_id:
        # Stale marker (worker wrote status without job_id, or hash got
        # truncated). Clear and proceed.
        redis_client.delete(progress_key)
        return None

    # Verify the recorded job is still alive in RQ. If it isn't, the
    # worker died mid-flight — clear the orphan key so the caller can
    # enqueue a new one.
    from rq.exceptions import NoSuchJobError
    from rq.job import Job

    try:
        Job.fetch(existing_job_id, connection=redis_client)
    except NoSuchJobError:
        redis_client.delete(progress_key)
        return None

    return existing_job_id
