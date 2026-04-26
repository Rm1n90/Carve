"""Batch auto-annotate: RQ job + Redis progress hash."""

import json
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from vaa_api.assets.models import Asset
from vaa_api.auth.models import User
from vaa_api.errors import AppError
from vaa_api.inference.autoannotate import (
    auto_annotate_asset,
    fetch_asset_bytes,
    presigned_url_for_weight,
)
from vaa_api.projects.models import Task
from vaa_api.weights.models import Weight


_PROGRESS_KEY_PREFIX = "aa:job:"
_PROGRESS_TTL_SECONDS = 24 * 3600


def progress_key(job_id: str) -> str:
    return f"{_PROGRESS_KEY_PREFIX}{job_id}"


@dataclass
class BatchJobPayload:
    """Serialisable args for the RQ job. RQ pickles these per call."""

    job_id: str
    actor_id: str
    task_id: str
    weight_id: str
    overwrite: bool


def build_job_payload(
    *,
    actor: User,
    task: Task,
    weight: Weight,
    overwrite: bool,
) -> BatchJobPayload:
    return BatchJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        weight_id=str(weight.id),
        overwrite=overwrite,
    )


def init_progress(redis_client, job_id: str, total: int) -> None:
    """Best-effort write of initial progress; swallow Redis errors."""
    if redis_client is None:
        return
    try:
        redis_client.hset(
            progress_key(job_id),
            mapping={
                "status": "running",
                "done": "0",
                "total": str(total),
                "failed": "0",
                "errors": "[]",
            },
        )
        redis_client.expire(progress_key(job_id), _PROGRESS_TTL_SECONDS)
    except Exception:
        pass


def update_progress(
    redis_client, job_id: str, *, done: int, failed: int, errors: list[str]
) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(
            progress_key(job_id),
            mapping={
                "done": str(done),
                "failed": str(failed),
                "errors": json.dumps(errors[-50:]),  # keep last 50 errors
            },
        )
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
    """Read progress; if Redis unavailable or key missing, return a default 'pending' payload."""
    default = {"status": "pending", "done": 0, "total": 0, "failed": 0, "errors": []}
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
        errors = json.loads(parsed.get("errors", "[]"))
    except json.JSONDecodeError:
        errors = []
    return {
        "status": parsed.get("status", "pending"),
        "done": int(parsed.get("done", 0)),
        "total": int(parsed.get("total", 0)),
        "failed": int(parsed.get("failed", 0)),
        "errors": errors,
    }


def list_assets_for_task(session: Session, task_id: uuid.UUID) -> list[Asset]:
    return list(
        session.execute(
            select(Asset).where(Asset.task_id == task_id).order_by(Asset.created_at)
        ).scalars()
    )


def run_batch_auto_annotate(payload: BatchJobPayload) -> dict:
    """RQ job entry point. Imports kept inside the function so RQ workers
    that load this module without a full FastAPI app can still pickle it.
    """
    from redis import Redis

    from vaa_api.config import get_settings
    from vaa_api.db import get_session_factory

    settings = get_settings()
    try:
        redis_client = Redis(host=settings.redis_host, port=settings.redis_port)
    except Exception:
        redis_client = None

    SessionLocal = get_session_factory()
    counts = {"done": 0, "failed": 0}
    errors: list[str] = []

    with SessionLocal.begin() as session:
        # Resolve actor / task / weight via the session
        actor = session.get(User, uuid.UUID(payload.actor_id))
        task = session.get(Task, uuid.UUID(payload.task_id))
        weight = session.get(Weight, uuid.UUID(payload.weight_id))
        if actor is None or task is None or weight is None:
            init_progress(redis_client, payload.job_id, 0)
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"status": "failed", "done": 0, "total": 0, "failed": 0}

        assets = list_assets_for_task(session, task.id)
        init_progress(redis_client, payload.job_id, len(assets))

        url = presigned_url_for_weight(weight)
        for asset in assets:
            try:
                body = fetch_asset_bytes(asset)
                auto_annotate_asset(
                    session=session,
                    actor=actor,
                    task=task,
                    asset=asset,
                    weight=weight,
                    overwrite=payload.overwrite,
                    presigned_url_for_weight=url,
                    image_bytes=body,
                )
                counts["done"] += 1
            except AppError as exc:
                counts["failed"] += 1
                errors.append(f"{asset.original_name}: {exc.code}")
            except Exception as exc:  # noqa: BLE001
                counts["failed"] += 1
                errors.append(f"{asset.original_name}: {type(exc).__name__}")
            update_progress(redis_client, payload.job_id, **counts, errors=errors)

    final_status = "completed" if counts["failed"] == 0 else "completed_with_errors"
    finalize_progress(redis_client, payload.job_id, status=final_status)
    return {"status": final_status, **counts, "total": len(assets)}
