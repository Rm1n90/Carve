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
from carve_api.inference.model_client import ModelServiceError, yolo_load
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
    # v3.7.5 — IOU (NMS) threshold, optional. ``None`` means "use the
    # autoannotate default (0.7)". Stored as Optional[float] so older
    # pickled payloads (without this field) still deserialise via the
    # dataclass default.
    iou: float | None = None
    class_overrides: dict[int, str | None] | None = None


def build_job_payload(
    *,
    actor: User,
    task: Task,
    weight: Weight,
    overwrite: bool,
    min_confidence: float | None = None,
    iou: float | None = None,
    class_overrides: dict[int, str | None] | None = None,
) -> BatchJobPayload:
    return BatchJobPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        weight_id=str(weight.id),
        overwrite=overwrite,
        min_confidence=min_confidence,
        iou=iou,
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


# v3.8 Phase 3.5 -- multi-asset SAM 3 text-prompt batch. Reuses the
# Redis progress hash helpers (init/update/finalize/read) so the
# frontend's BatchProgressDialog works for both YOLO and SAM-text.

@dataclass
class AutoTextBatchPayload:
    """Serialisable args for the SAM 3 text auto-annotate batch job."""

    job_id: str
    actor_id: str
    task_id: str
    class_ids: list[str]
    threshold: float
    find_all: bool
    overwrite: bool


def build_auto_text_payload(
    *,
    actor: User,
    task: Task,
    class_ids: list[uuid.UUID],
    threshold: float,
    find_all: bool,
    overwrite: bool,
) -> AutoTextBatchPayload:
    return AutoTextBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        class_ids=[str(c) for c in class_ids],
        threshold=float(threshold),
        find_all=bool(find_all),
        overwrite=bool(overwrite),
    )


def run_auto_text_batch(payload: AutoTextBatchPayload) -> dict:
    """RQ job entry point for the SAM 3 text-prompt multi-asset batch.

    Imports inside the function so RQ workers that load this module
    without a full FastAPI app stack still pickle/unpickle cleanly.
    Mirrors run_batch_auto_annotate's session/commit semantics:
    single shared session for the whole batch, per-asset commit, per-
    asset rollback on failure (so one bad asset doesn't poison the rest).
    """
    import os

    import redis as _redis
    from carve_api.db import get_session_factory
    from carve_api.inference.auto_text import auto_text_for_asset
    from carve_api.projects.models import Class as ClassModel

    redis_client = None
    try:
        redis_client = _redis.Redis(
            host=os.environ.get("REDIS_HOST", "redis"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "auto_text_batch: redis init failed; running without progress"
        )

    task_uuid = uuid.UUID(payload.task_id)
    actor_uuid = uuid.UUID(payload.actor_id)
    class_uuids = [uuid.UUID(c) for c in payload.class_ids]

    total_created = 0
    failed = 0
    errors: list[str] = []

    session = get_session_factory()()
    try:
        task = session.get(Task, task_uuid)
        if task is None:
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"ok": False, "error": "task_not_found"}

        classes = (
            session.query(ClassModel)
            .filter(
                ClassModel.id.in_(class_uuids),
                ClassModel.project_id == task.project_id,
            )
            .all()
        )
        if not classes:
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"ok": False, "error": "no_matching_classes"}

        assets = list_assets_for_task(session, task_uuid)
        init_progress(redis_client, payload.job_id, total=len(assets))

        canceled = False
        for i, asset in enumerate(assets):
            # v3.8 Phase 3.5 -- co-operative cancel: between assets,
            # check the progress hash for status="canceled" written by
            # the API's cancel endpoint. Per-asset commits ensure all
            # work done so far is preserved.
            if redis_client is not None:
                try:
                    cur_status = redis_client.hget(
                        progress_key(payload.job_id), "status"
                    )
                    if cur_status == "canceled":
                        canceled = True
                        break
                except Exception:
                    # Best-effort -- if Redis blips we keep going.
                    pass
            try:
                result = auto_text_for_asset(
                    session=session,
                    asset=asset,
                    task=task,
                    classes=classes,
                    threshold=payload.threshold,
                    find_all=payload.find_all,
                    overwrite=payload.overwrite,
                    actor_id=actor_uuid,
                )
                session.commit()
                total_created += int(result.get("annotations_created", 0))
            except (AppError, ModelServiceError) as exc:
                session.rollback()
                failed += 1
                errors.append(_truncated_repr(exc, limit=200))
                log.warning(
                    "auto_text_batch: asset %s failed: %s",
                    asset.id,
                    _truncated_repr(exc),
                )
            except Exception as exc:  # noqa: BLE001
                session.rollback()
                failed += 1
                errors.append(_truncated_repr(exc, limit=200))
                log.exception("auto_text_batch: asset %s unexpected error", asset.id)

            update_progress(
                redis_client,
                payload.job_id,
                done=i + 1,
                failed=failed,
                errors=errors[-20:],
                total_annotations_created=total_created,
                total_skipped_detections=0,
                skipped_by_class={},
            )

        if canceled:
            finalize_progress(redis_client, payload.job_id, status="canceled")
            return {
                "ok": True,
                "canceled": True,
                "annotations_created": total_created,
                "failed": failed,
            }
        finalize_progress(
            redis_client,
            payload.job_id,
            status="completed" if failed == 0 else "completed_with_errors",
        )
        return {"ok": True, "annotations_created": total_created, "failed": failed}
    finally:
        session.close()


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

    v3.7.6 — single shared session for the whole batch, with explicit
    ``session.commit()`` per asset and ``session.rollback()`` on per-asset
    failures.

    Why this contract: v3.7.3 created a fresh ``Session()`` per asset to
    avoid ORM staleness cascading across iterations. That fixed
    correctness but introduced two new problems on real batches:

    1. **Pool thrashing.** Each iteration acquired a connection from the
       SQLAlchemy pool, held it idle across the (multi-second) HTTPX
       call to the model service, then released it. A 545-asset batch
       acquired 545 connections — surfacing as
       ``psycopg.OperationalError: another command is already in
       progress`` once the pool started returning the same physical
       connection while a previous handle was still mid-query.
    2. **Latency.** Pool acquisition + per-connection setup multiplied
       per asset, making the v3.7.3 batch path noticeably slower than
       the (buggy) v3.7.1 single-session path.

    v3.7.6 keeps ONE session open for the whole batch. ``actor_db``,
    ``task_db`` and ``weight_db`` are fetched once outside the loop —
    the autoannotate path reads them but does not mutate them, and
    ``expire_on_commit=True`` will refresh them lazily if needed.
    Per-asset ``session.commit()`` makes each asset's annotations
    durable immediately (preserves the v3.7.1 fix). Per-asset
    ``session.rollback()`` on exception keeps the session usable for
    the next iteration (a session in a "failed" transaction state
    refuses subsequent operations, which would have re-introduced the
    cascading-failure bug from before v3.7.3).

    Critically, this does NOT use ``with SessionLocal.begin()`` — that
    wraps the whole loop in a single transaction and the per-asset
    ``session.commit()`` calls become no-ops, which is exactly the
    v3.7.1 bug.
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

    # IDs we'll fetch ONCE on the shared session before the loop starts.
    actor_uuid = uuid.UUID(payload.actor_id)
    task_uuid = uuid.UUID(payload.task_id)
    weight_uuid = uuid.UUID(payload.weight_id)

    # ---- Phase 2: ONE shared session for the whole batch ----
    # NOTE: Do NOT use ``with SessionLocal.begin()`` here. That wraps the
    # entire loop in a single transaction and turns the per-asset
    # ``session.commit()`` calls into savepoint releases, so a worker
    # kill mid-batch loses every prior asset's annotations. This is the
    # v3.7.1 regression we explicitly avoid.
    session = SessionLocal()

    # Pre-fetch shared references once. The autoannotate path reads
    # these but doesn't mutate them, so a single fetch is safe across
    # the whole batch. ``expire_on_commit`` will refresh them lazily
    # on next attribute access if needed.
    actor_db = session.get(User, actor_uuid)
    task_db = session.get(Task, task_uuid)
    weight_db = session.get(Weight, weight_uuid)
    if actor_db is None or task_db is None or weight_db is None:
        log.error(
            "batch.refs.missing job_id=%s actor=%s task=%s weight=%s",
            payload.job_id,
            actor_db is not None,
            task_db is not None,
            weight_db is not None,
        )
        session.close()
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {
            "status": "failed",
            "done": 0,
            "total": len(asset_ids),
            "failed": 0,
            "errors": ["refs:missing_after_boot"],
        }

    # ---- v3.7.7 — load the weight on the model service ONCE before the loop.
    #
    # Pre-v3.7.7 ``auto_annotate_asset`` called ``yolo_load`` per-asset; on a
    # 545-asset batch that meant 545 HTTP roundtrips to the model service
    # even though the LRU cache hit on every call after the first. Worse, if
    # the (presigned) weight URL expired mid-batch the cascade surfaced as
    # ``weight_download_failed`` on every late asset instead of one clear
    # failure. We now load once here and pass ``skip_yolo_load=True`` per
    # asset.
    try:
        yolo_load(str(weight_uuid), url)
        log.info(
            "batch.weight.loaded job_id=%s weight_id=%s",
            payload.job_id,
            payload.weight_id,
        )
    except ModelServiceError as exc:
        log.exception(
            "batch.weight.load_failed job_id=%s weight_id=%s status=%s",
            payload.job_id,
            payload.weight_id,
            exc.status_code,
        )
        session.close()
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {
            "status": "failed",
            "done": 0,
            "total": len(asset_ids),
            "failed": 0,
            "errors": [f"weight_load_failed_at_start: {exc.status_code}"],
        }
    except Exception as exc:  # noqa: BLE001
        log.exception(
            "batch.weight.load_failed.unexpected job_id=%s weight_id=%s",
            payload.job_id,
            payload.weight_id,
        )
        session.close()
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {
            "status": "failed",
            "done": 0,
            "total": len(asset_ids),
            "failed": 0,
            "errors": [f"weight_load_failed_at_start: {type(exc).__name__}"],
        }

    try:
        for asset_id in asset_ids:
            original_name = asset_names_by_id.get(asset_id, str(asset_id))
            try:
                asset_db = session.get(Asset, asset_id)
                if asset_db is None:
                    # Asset was deleted between list and process.
                    counts["failed"] += 1
                    errors.append(f"{original_name}: asset_not_found")
                    log.warning(
                        "batch.asset.missing job_id=%s asset_id=%s name=%s",
                        payload.job_id,
                        asset_id,
                        original_name,
                    )
                    update_progress(
                        redis_client,
                        payload.job_id,
                        **counts,
                        errors=errors,
                        **aggregates,
                    )
                    continue

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
                    # v3.7.7 — weight already loaded on the model service ONCE
                    # before the loop (above). Skip the per-asset yolo_load
                    # roundtrip; the LRU cache would have made it a no-op
                    # anyway, but the HTTP overhead added up to ~545 unnecessary
                    # calls per batch.
                    skip_yolo_load=True,
                )
                if clamped_conf is not None:
                    aa_kwargs["min_confidence"] = clamped_conf
                # v3.7.5 — only forward iou when the caller actually
                # supplied it; the autoannotate default (0.7) holds
                # otherwise. Keeps the kwargs symmetric with the
                # legacy-payload omission test.
                if payload.iou is not None:
                    aa_kwargs["iou"] = float(payload.iou)
                if coerced_overrides is not None:
                    aa_kwargs["class_overrides"] = coerced_overrides
                aa_result = auto_annotate_asset(**aa_kwargs)
                # Per-asset commit so partial progress is durable on
                # worker kill. Releases the connection back to idle so
                # the next HTTPX call doesn't pin it.
                session.commit()

                counts["done"] += 1
                created = int(getattr(aa_result, "annotations_created", 0) or 0)
                skipped = int(getattr(aa_result, "skipped_count", 0) or 0)
                aggregates["total_annotations_created"] += created
                aggregates["total_skipped_detections"] += skipped
                # v3.7.4 — merge per-class skip counts into the
                # batch-level aggregate so the toast can name them.
                # Defensive: tolerate missing/garbage values (e.g.
                # older test stubs).
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
                # Rollback so the session is usable for the next asset.
                # Without this the session enters a "failed" transaction
                # state and every subsequent .get / .commit raises
                # InvalidRequestError.
                try:
                    session.rollback()
                except Exception:  # noqa: BLE001
                    pass
                counts["failed"] += 1
                errors.append(f"{original_name}: {exc.code}")
                log.exception(
                    "batch.asset.failed.app_error job_id=%s asset_id=%s "
                    "code=%s",
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
                    "batch.asset.failed.unexpected job_id=%s asset_id=%s "
                    "type=%s",
                    payload.job_id,
                    asset_id,
                    type(exc).__name__,
                )

            update_progress(
                redis_client,
                payload.job_id,
                **counts,
                errors=errors,
                **aggregates,
            )
    finally:
        session.close()

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
