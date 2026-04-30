"""Batch auto-annotate: RQ job + Redis progress hash."""

import json
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.assets.models import Asset
from carve_api.auth.models import User
from carve_api.errors import AppError
from carve_api.inference.autoannotate import (
    auto_annotate_asset,
    fetch_asset_bytes,
    presigned_url_for_weight,
)
from carve_api.projects.models import Task
from carve_api.weights.models import Weight


log = logging.getLogger(__name__)


_PROGRESS_KEY_PREFIX = "aa:job:"
_PROGRESS_TTL_SECONDS = 24 * 3600


def progress_key(job_id: str) -> str:
    return f"{_PROGRESS_KEY_PREFIX}{job_id}"


@dataclass
class BatchJobPayload:
    """Serialisable args for the RQ job. RQ pickles these per call.

    v3.7 Phase 2 Issue 1 — ``min_confidence`` and ``class_overrides`` are
    threaded through so the batch path mirrors the single-asset path
    (``router.auto_annotate``). Keys in ``class_overrides`` are
    weight-class indices (int); values are project-class id UUID strings
    or ``None`` for "skip this weight class for this run". Both fields
    default to ``None`` so older queued payloads (without these fields)
    still deserialise — RQ pickles dataclasses, and adding fields with
    defaults is backward-compatible for any in-flight pickled jobs.
    """

    job_id: str
    actor_id: str
    task_id: str
    weight_id: str
    overwrite: bool
    min_confidence: float | None = None
    class_overrides: dict[int, str | None] | None = None


def build_job_payload(
    *,
    actor: User,
    task: Task,
    weight: Weight,
    overwrite: bool,
    min_confidence: float | None = None,
    class_overrides: dict[int, str | None] | None = None,
) -> BatchJobPayload:
    return BatchJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        weight_id=str(weight.id),
        overwrite=overwrite,
        min_confidence=min_confidence,
        class_overrides=class_overrides,
    )


def init_progress(redis_client, job_id: str, total: int) -> None:
    """Best-effort write of initial progress; swallow Redis errors.

    v3.7.2 — adds ``total_annotations_created`` and ``total_skipped_detections``
    so the polling endpoint can surface aggregate counts (e.g. "Created 0
    annotations across 80 assets — check class mapping").

    v3.7.4 — adds ``skipped_by_class_json`` so the post-batch toast can
    name the most-skipped weight classes (e.g. "person (412), boat (305)")
    instead of just a count. Stored as a JSON-encoded ``dict[str, int]``.
    """
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
                "total_annotations_created": "0",
                "total_skipped_detections": "0",
                "skipped_by_class_json": "{}",
            },
        )
        redis_client.expire(progress_key(job_id), _PROGRESS_TTL_SECONDS)
    except Exception:
        pass


def update_progress(
    redis_client,
    job_id: str,
    *,
    done: int,
    failed: int,
    errors: list[str],
    total_annotations_created: int = 0,
    total_skipped_detections: int = 0,
    skipped_by_class: dict[str, int] | None = None,
) -> None:
    """v3.7.2 — extended with aggregate created/skipped counts so the
    frontend can surface a clear post-batch summary toast.

    The new args default to 0 so any external caller that doesn't
    track counts keeps working; the worker always passes them.

    v3.7.4 — also persists ``skipped_by_class`` (per-class skip counts)
    as a JSON-encoded hash field so the polling endpoint and the toast
    can name the unmapped classes.
    """
    if redis_client is None:
        return
    try:
        redis_client.hset(
            progress_key(job_id),
            mapping={
                "done": str(done),
                "failed": str(failed),
                "errors": json.dumps(errors[-50:]),  # keep last 50 errors
                "total_annotations_created": str(total_annotations_created),
                "total_skipped_detections": str(total_skipped_detections),
                "skipped_by_class_json": json.dumps(skipped_by_class or {}),
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
    """Read progress; if Redis unavailable or key missing, return a default 'pending' payload.

    v3.7.2 — surfaces ``total_annotations_created`` and
    ``total_skipped_detections`` so the frontend can show a clear
    "Created N annotations across M of K assets" toast.
    """
    default = {
        "status": "pending",
        "done": 0,
        "total": 0,
        "failed": 0,
        "errors": [],
        "total_annotations_created": 0,
        "total_skipped_detections": 0,
        "skipped_by_class": {},
    }
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
    # v3.7.4 — surface per-class skip counts so the post-batch toast can
    # name the most common unmapped weight classes. Decode defensively;
    # a malformed value falls back to {} so polling never crashes.
    try:
        skipped_by_class_raw = json.loads(
            parsed.get("skipped_by_class_json", "{}")
        )
    except json.JSONDecodeError:
        skipped_by_class_raw = {}
    if not isinstance(skipped_by_class_raw, dict):
        skipped_by_class_raw = {}
    skipped_by_class: dict[str, int] = {}
    for k, v in skipped_by_class_raw.items():
        try:
            skipped_by_class[str(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return {
        "status": parsed.get("status", "pending"),
        "done": int(parsed.get("done", 0)),
        "total": int(parsed.get("total", 0)),
        "failed": int(parsed.get("failed", 0)),
        "errors": errors,
        "total_annotations_created": int(
            parsed.get("total_annotations_created", 0)
        ),
        "total_skipped_detections": int(
            parsed.get("total_skipped_detections", 0)
        ),
        "skipped_by_class": skipped_by_class,
    }


def list_assets_for_task(session: Session, task_id: uuid.UUID) -> list[Asset]:
    return list(
        session.execute(
            select(Asset).where(Asset.task_id == task_id).order_by(Asset.created_at)
        ).scalars()
    )


def _coerce_overrides(
    raw: dict[int, str | None] | None,
) -> dict[int, uuid.UUID | None] | None:
    """Coerce wire-form overrides (str / None) to UUIDs for the autoannotate
    layer. Bad UUIDs are dropped (falls through to name-match)."""
    if raw is None:
        return None
    coerced: dict[int, uuid.UUID | None] = {}
    for idx_key, val in raw.items():
        try:
            idx = int(idx_key)
        except (TypeError, ValueError):
            continue
        if val is None:
            coerced[idx] = None
            continue
        try:
            coerced[idx] = uuid.UUID(str(val))
        except (TypeError, ValueError):
            continue
    return coerced


def _truncated_repr(obj, limit: int = 400) -> str:
    """Short repr for log lines so a 576-asset payload doesn't flood logs."""
    text = repr(obj)
    if len(text) <= limit:
        return text
    return text[:limit] + f"... <truncated, len={len(text)}>"


def run_batch_auto_annotate(payload: BatchJobPayload) -> dict:
    """RQ job entry point. Imports kept inside the function so RQ workers
    that load this module without a full FastAPI app can still pickle it.

    v3.7.3 — fresh session per asset. The previous implementation kept
    a single ``Session()`` open across the whole loop and called
    ``session.commit()`` after each asset. After commit, all ORM objects
    bound to that session (``actor``, ``task``, ``weight``, plus every
    queried ``Class`` / ``Frame`` / ``WeightAssignment``) are expired.
    Any silent failure during the next iteration's auto-refresh would
    cascade as ``DetachedInstanceError`` or ``StaleDataError`` and the
    loop would skip every remaining asset under
    ``except Exception:`` while still reporting "completed". The fix
    here isolates each asset in its own ``Session()`` + ``Session.begin()``
    transaction; ORM staleness cannot leak across iterations.
    """
    from redis import Redis

    from carve_api.config import get_settings
    from carve_api.db import get_session_factory

    settings = get_settings()
    try:
        redis_client = Redis(host=settings.redis_host, port=settings.redis_port)
    except Exception:
        redis_client = None

    SessionLocal = get_session_factory()
    counts = {"done": 0, "failed": 0}
    # v3.7.4 — also track per-class skip counts so the post-batch toast
    # can name the dominant unmapped classes (e.g. "person (412), boat (305)")
    # instead of just an opaque "Skipped N detections" number.
    aggregates: dict = {
        "total_annotations_created": 0,
        "total_skipped_detections": 0,
        "skipped_by_class": {},
    }
    errors: list[str] = []

    log.info(
        "batch.start job_id=%s task_id=%s weight_id=%s actor_id=%s "
        "overwrite=%s min_confidence=%s class_overrides=%s",
        payload.job_id,
        payload.task_id,
        payload.weight_id,
        payload.actor_id,
        payload.overwrite,
        payload.min_confidence,
        _truncated_repr(payload.class_overrides),
    )

    # ---- Phase 1: short-lived boot session — resolve refs + fetch asset list ----
    asset_ids: list[uuid.UUID] = []
    asset_names_by_id: dict[uuid.UUID, str] = {}
    try:
        with SessionLocal() as boot:
            actor = boot.get(User, uuid.UUID(payload.actor_id))
            task = boot.get(Task, uuid.UUID(payload.task_id))
            weight = boot.get(Weight, uuid.UUID(payload.weight_id))
            if actor is None or task is None or weight is None:
                log.error(
                    "batch.boot.missing job_id=%s actor=%s task=%s weight=%s",
                    payload.job_id,
                    actor is not None,
                    task is not None,
                    weight is not None,
                )
                init_progress(redis_client, payload.job_id, 0)
                finalize_progress(redis_client, payload.job_id, status="failed")
                return {"status": "failed", "done": 0, "total": 0, "failed": 0}

            assets = list_assets_for_task(boot, task.id)
            asset_ids = [a.id for a in assets]
            asset_names_by_id = {a.id: a.original_name for a in assets}
            init_progress(redis_client, payload.job_id, len(assets))

            # Compute the presigned URL once (cheap; reused per asset).
            url = presigned_url_for_weight(weight)
    except Exception as exc:  # noqa: BLE001
        log.exception("batch.boot.failed job_id=%s", payload.job_id)
        init_progress(redis_client, payload.job_id, 0)
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {
            "status": "failed",
            "done": 0,
            "total": 0,
            "failed": 0,
            "errors": [f"boot:{type(exc).__name__}"],
        }

    log.info(
        "batch.assets job_id=%s total=%d url_set=%s",
        payload.job_id,
        len(asset_ids),
        bool(url),
    )

    # Coerce / clamp wire fields once.
    coerced_overrides = _coerce_overrides(payload.class_overrides)
    clamped_conf: float | None
    if payload.min_confidence is None:
        clamped_conf = None
    else:
        clamped_conf = max(0.0, min(1.0, float(payload.min_confidence)))

    # IDs we'll re-fetch in each iteration's fresh session.
    actor_uuid = uuid.UUID(payload.actor_id)
    task_uuid = uuid.UUID(payload.task_id)
    weight_uuid = uuid.UUID(payload.weight_id)

    # ---- Phase 2: per-asset, fresh session + transaction ----
    for asset_id in asset_ids:
        original_name = asset_names_by_id.get(asset_id, str(asset_id))
        session = SessionLocal()
        try:
            actor_db = session.get(User, actor_uuid)
            task_db = session.get(Task, task_uuid)
            weight_db = session.get(Weight, weight_uuid)
            asset_db = session.get(Asset, asset_id)
            if (
                actor_db is None
                or task_db is None
                or weight_db is None
                or asset_db is None
            ):
                raise RuntimeError(
                    f"missing rows on refetch: actor={actor_db is not None} "
                    f"task={task_db is not None} weight={weight_db is not None} "
                    f"asset={asset_db is not None}"
                )

            body = fetch_asset_bytes(asset_db)
            aa_kwargs: dict = dict(
                session=session,
                actor=actor_db,
                task=task_db,
                asset=asset_db,
                weight=weight_db,
                overwrite=payload.overwrite,
                presigned_url_for_weight=url,
                image_bytes=body,
            )
            if clamped_conf is not None:
                aa_kwargs["min_confidence"] = clamped_conf
            if coerced_overrides is not None:
                aa_kwargs["class_overrides"] = coerced_overrides
            aa_result = auto_annotate_asset(**aa_kwargs)
            # Commit per-asset so partial progress is durable on worker
            # kill. Each iteration uses a fresh Session, so ORM staleness
            # cannot leak across iterations.
            session.commit()

            counts["done"] += 1
            created = int(getattr(aa_result, "annotations_created", 0) or 0)
            skipped = int(getattr(aa_result, "skipped_count", 0) or 0)
            aggregates["total_annotations_created"] += created
            aggregates["total_skipped_detections"] += skipped
            # v3.7.4 — merge per-class skip counts into the batch-level
            # aggregate so the toast can name them. Defensive: tolerate
            # missing/garbage values (e.g. older test stubs).
            per_asset_skipped = getattr(aa_result, "skipped_by_class", None)
            if isinstance(per_asset_skipped, dict):
                bucket: dict[str, int] = aggregates["skipped_by_class"]
                for class_name, count in per_asset_skipped.items():
                    try:
                        n = int(count)
                    except (TypeError, ValueError):
                        continue
                    if n <= 0:
                        continue
                    name = str(class_name)
                    bucket[name] = bucket.get(name, 0) + n

            if created == 0:
                log.warning(
                    "batch.asset.zero_created job_id=%s asset_id=%s "
                    "name=%s skipped=%d skipped_by_class=%s "
                    "overwrite_skipped=%s",
                    payload.job_id,
                    asset_id,
                    original_name,
                    skipped,
                    _truncated_repr(
                        getattr(aa_result, "skipped_by_class", {})
                    ),
                    getattr(aa_result, "overwrite_skipped", False),
                )
        except AppError as exc:
            try:
                session.rollback()
            except Exception:  # noqa: BLE001
                pass
            counts["failed"] += 1
            errors.append(f"{original_name}: {exc.code}")
            log.exception(
                "batch.asset.failed.app_error job_id=%s asset_id=%s code=%s",
                payload.job_id,
                asset_id,
                exc.code,
            )
        except Exception as exc:  # noqa: BLE001
            try:
                session.rollback()
            except Exception:  # noqa: BLE001
                pass
            counts["failed"] += 1
            errors.append(f"{original_name}: {type(exc).__name__}")
            log.exception(
                "batch.asset.failed.unexpected job_id=%s asset_id=%s type=%s",
                payload.job_id,
                asset_id,
                type(exc).__name__,
            )
        finally:
            session.close()

        update_progress(
            redis_client,
            payload.job_id,
            **counts,
            errors=errors,
            **aggregates,
        )

    final_status = "completed" if counts["failed"] == 0 else "completed_with_errors"
    finalize_progress(redis_client, payload.job_id, status=final_status)
    log.info(
        "batch.done job_id=%s status=%s done=%d failed=%d total=%d "
        "created=%d skipped=%d errors=%s",
        payload.job_id,
        final_status,
        counts["done"],
        counts["failed"],
        len(asset_ids),
        aggregates["total_annotations_created"],
        aggregates["total_skipped_detections"],
        _truncated_repr(errors),
    )
    return {
        "status": final_status,
        **counts,
        "total": len(asset_ids),
        "errors": errors[-50:],
        **aggregates,
    }
