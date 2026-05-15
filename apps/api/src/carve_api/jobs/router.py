# Armin Mehri — mehri.armin@gmail.com
"""Admin Jobs/queue inspection + control.

A workspace-admin-only view over the RQ priority lanes (high / default
/ low) plus the started + failed registries, with per-job cancel/stop
and "bump to the high lane". Jobs span all projects and users, and
cancel/stop is destructive to in-flight work, so every endpoint is
gated by ``get_current_admin_user``.

RQ mechanics (enumerate / cancel / reprioritize) live in
``carve_api.jobs.queue`` so this router and the batch endpoints share
one implementation.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from redis import Redis

from carve_api.auth.models import User
from carve_api.config import get_settings
from carve_api.deps import get_current_admin_user
from carve_api.jobs.queue import (
    clear_failed_jobs,
    iter_jobs,
    try_cancel_rq_job,
    try_reprioritize_rq_job,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])
log = logging.getLogger(__name__)


def _redis_or_503() -> Redis:
    """Bytes-mode client (RQ stores pickled job data — never decode).

    ``read_progress`` decodes defensively on its own, so the same
    connection serves both RQ enumeration and the progress hash.
    """
    s = get_settings()
    try:
        client = Redis(
            host=s.redis_host, port=s.redis_port, socket_connect_timeout=1
        )
        client.ping()
        return client
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="redis_unavailable") from exc


class JobRow(BaseModel):
    id: str
    func: str
    description: str | None = None
    lane: str
    state: str  # queued | running | failed
    enqueued_at: str | None = None
    started_at: str | None = None
    # Batch-progress enrichment — present only for jobs that wrote an
    # ``aa:job:<id>`` progress hash (auto-annotate / predict batches).
    progress_status: str | None = None
    done: int | None = None
    total: int | None = None
    created: int | None = None


class JobsList(BaseModel):
    jobs: list[JobRow]


def _enrich(client, jid: str) -> dict:
    """Attach batch progress only when a real hash exists.

    ``read_progress`` returns a synthetic ``pending/0`` default for a
    missing key, so we gate on ``EXISTS`` to avoid labelling every
    thumbnail/import job as a stalled batch.
    """
    from carve_api.inference.batch import progress_key, read_progress

    try:
        if not client.exists(progress_key(jid)):
            return {}
        p = read_progress(client, jid)
        return {
            "progress_status": p.get("status"),
            "done": int(p.get("done", 0)),
            "total": int(p.get("total", 0)),
            "created": int(p.get("total_annotations_created", 0)),
        }
    except Exception:  # noqa: BLE001
        return {}


@router.get("", response_model=JobsList)
def list_jobs(user: User = Depends(get_current_admin_user)) -> JobsList:  # noqa: ARG001
    client = _redis_or_503()
    rows = iter_jobs(client)
    for r in rows:
        r.update(_enrich(client, r["id"]))
    return JobsList(jobs=[JobRow(**r) for r in rows])


@router.post("/{job_id}/cancel")
def cancel_job(
    job_id: str,
    user: User = Depends(get_current_admin_user),  # noqa: ARG001
) -> dict:
    """Cancel a queued job (removed from its lane) or stop a running
    one. For batch jobs we also set the cooperative ``canceled`` flag
    so the worker breaks at its next per-asset checkpoint, keeping
    already-committed annotations."""
    client = _redis_or_503()
    try:
        from carve_api.inference.batch import progress_key

        if client.exists(progress_key(job_id)):
            client.hset(progress_key(job_id), "status", "canceled")
    except Exception:  # noqa: BLE001
        log.warning("jobs.cancel: cooperative flag failed", exc_info=True)
    try_cancel_rq_job(client, job_id)
    return {"job_id": job_id, "status": "canceled"}


@router.post("/{job_id}/reprioritize")
def reprioritize_job(
    job_id: str,
    user: User = Depends(get_current_admin_user),  # noqa: ARG001
) -> dict:
    """Bump a still-queued job to the ``high`` lane so the worker runs
    it next. Running/finished jobs can't be reordered."""
    client = _redis_or_503()
    result = try_reprioritize_rq_job(client, job_id, dest="high")
    if result == "error":
        raise HTTPException(status_code=502, detail="reprioritize_failed")
    return {"job_id": job_id, "result": result}


@router.post("/failed:clear")
def clear_failed(
    user: User = Depends(get_current_admin_user),  # noqa: ARG001
) -> dict:
    """Remove every failed job across the priority lanes.

    Running and queued jobs are untouched — this purges only the
    failed registry that the admin Jobs page surfaces. Returns the
    total count cleared so the UI can show a count-aware toast.
    """
    client = _redis_or_503()
    try:
        cleared = clear_failed_jobs(client)
    except Exception as exc:  # noqa: BLE001
        log.exception("jobs.clear_failed: sweep failed")
        raise HTTPException(status_code=502, detail="clear_failed_jobs_failed") from exc
    return {"cleared": cleared}
