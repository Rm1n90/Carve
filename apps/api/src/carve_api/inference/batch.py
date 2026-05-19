# Armin Mehri — mehri.armin@gmail.com
"""Batch auto-annotate: RQ job + Redis progress hash."""

import json
import logging
import traceback
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
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


def _refresh_ttl(redis_client, job_id: str) -> None:
    """Push the progress hash's expiry forward to a fresh
    ``_PROGRESS_TTL_SECONDS`` window.

    CRITICAL for chunked batches: ``init_progress`` sets the TTL only on
    the *first* chunk, and Redis ``HSET`` does NOT reset a key's TTL. A
    100K-image batch runs for days — far beyond 24h — so without a
    rolling refresh the hash (and the resume ``cursor`` it holds) would
    expire mid-run, ``read_cursor`` would return ``None``, and the next
    chunk would restart the whole batch from asset 0 forever. Called
    from every per-asset write so the key lives as long as the batch is
    making progress, then gets cleaned up ~24h after the last update.
    Best-effort: a Redis blip must never break the batch.
    """
    if redis_client is None:
        return
    try:
        redis_client.expire(progress_key(job_id), _PROGRESS_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        pass


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
    # v3.31 — optional subset filter. When non-None the worker only
    # iterates assets whose id appears in this list (still in the
    # canonical task order). Used by the "Range: from N to M" scope
    # picker. ``None`` keeps the legacy "every asset in the task"
    # behaviour and stays wire-compatible with older pickled payloads.
    asset_ids: list[str] | None = None
    # v3.31 — cross-class hierarchical NMS. ``False`` keeps the legacy
    # behaviour (intra-class dedup only). Default reads cleanly for
    # payloads pickled before this field existed.
    resolve_hierarchy: bool = False
    hierarchy_iou: float = 0.7


def build_job_payload(
    *,
    actor: User,
    task: Task,
    weight: Weight,
    overwrite: bool,
    min_confidence: float | None = None,
    iou: float | None = None,
    class_overrides: dict[int, str | None] | None = None,
    asset_ids: list[str] | None = None,
    resolve_hierarchy: bool = False,
    hierarchy_iou: float = 0.7,
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
        asset_ids=list(asset_ids) if asset_ids else None,
        resolve_hierarchy=bool(resolve_hierarchy),
        hierarchy_iou=float(hierarchy_iou),
    )


# ---------------------------------------------------------------------------
# GPU admission retry helpers — keep a single per-asset call from killing the
# whole batch when another inference is holding the GPU's only inference slot.
# When the model service's admission gate rejects with gpu_busy / gpu_oom_risk
# (see ``apps/model/src/carve_model/admission.py``) we back off and retry
# the SAME asset, posting ``status=waiting_for_gpu`` to the Redis progress
# hash so the UI can render a "Waiting for GPU…" badge instead of treating
# this as a per-asset failure.
# ---------------------------------------------------------------------------

_ADMISSION_CODES = frozenset({"gpu_busy", "gpu_oom_risk"})


def _is_admission_error(exc: Exception) -> bool:
    """True when ``exc`` is a model-side admission rejection."""
    # GpuAdmissionError (api-side) carries a typed payload dict.
    payload = getattr(exc, "payload", None)
    if isinstance(payload, dict):
        code = payload.get("code") or payload.get("error")
        if code in _ADMISSION_CODES:
            return True
    # ModelServiceError carries the raw response body.
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        inner = body.get("detail") if isinstance(body.get("detail"), dict) else body
        if isinstance(inner, dict):
            code = inner.get("code") or inner.get("error")
            if code in _ADMISSION_CODES:
                return True
    return False


def _set_progress_status(redis_client, job_id: str, status: str) -> None:
    """Best-effort write of the status field on the progress hash."""
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), "status", status)
    except Exception:  # noqa: BLE001
        pass
    # Keeps the key alive across continuation begins and long
    # ``waiting_for_gpu`` admission backoffs (see _refresh_ttl).
    _refresh_ttl(redis_client, job_id)


def _run_with_admission_retry(
    fn,
    *,
    redis_client,
    job_id: str,
    asset_label: str,
    max_attempts: int = 6,
    base_delay_s: float = 1.0,
    max_delay_s: float = 30.0,
):
    """Run ``fn()`` with retry-on-GPU-admission backoff.

    On every ``gpu_busy`` / ``gpu_oom_risk`` rejection we publish
    ``status=waiting_for_gpu`` to the progress hash, sleep with
    exponential backoff (capped at ``max_delay_s``), and retry the
    same call up to ``max_attempts`` times. Any other error bubbles
    up to the caller's normal per-asset failure handling. After a
    successful retry we restore ``status=running`` so the UI badge
    clears.

    Total worst-case wait at defaults: 1 + 2 + 4 + 8 + 16 + 30 = ~61 s.
    """
    import time

    delay = base_delay_s
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            result = fn()
            if attempt > 0:
                _set_progress_status(redis_client, job_id, "running")
            return result
        except Exception as exc:  # noqa: BLE001
            if not _is_admission_error(exc):
                raise
            last_exc = exc
            _set_progress_status(redis_client, job_id, "waiting_for_gpu")
            log.info(
                "batch.admission.wait job=%s asset=%s attempt=%d delay=%.1fs",
                job_id,
                asset_label,
                attempt + 1,
                delay,
            )
            time.sleep(min(delay, max_delay_s))
            delay = min(delay * 2.0, max_delay_s)
    # All retries exhausted — re-raise so the caller's per-asset
    # failure handler can record the asset as failed normally.
    if last_exc is not None:
        raise last_exc
    return None  # unreachable


def init_progress(
    redis_client,
    job_id: str,
    total: int,
    status: str = "running",
    *,
    kind: str | None = None,
) -> None:
    """Best-effort write of initial progress; swallow Redis errors.

    v3.7.2 — adds ``total_annotations_created`` and ``total_skipped_detections``
    so the polling endpoint can surface aggregate counts (e.g. "Created 0
    annotations across 80 assets — check class mapping").

    v3.7.4 — adds ``skipped_by_class_json`` so the post-batch toast can
    name the most-skipped weight classes (e.g. "person (412), boat (305)")
    instead of just a count. Stored as a JSON-encoded ``dict[str, int]``.

    v3.32 — ``kind`` identifies the batch type ("sam-auto-text",
    "sam-auto-visual", "yolo-predict-batch", "yoloe-batch"). The
    SAM-switch active-batch guard (``count_active_jobs``) filters by
    this field so a running YOLO/YOLOE batch — which does NOT touch
    SAM — never blocks a SAM variant switch. When ``kind`` is None we
    omit the field from the hset mapping so a worker re-initialising
    the hash mid-job doesn't wipe the kind set at enqueue time.

    ``status`` defaults to ``running`` (the worker's call, made the moment
    it begins the per-asset loop). The enqueue endpoint calls this with
    ``status="queued"`` so the polling endpoint returns a real
    ``total``/state the instant the job is queued — the UI then shows
    "Queued — N assets" instead of a contentless "Initialising…" until
    the worker (single, possibly mid-batch) gets to it. The worker's
    later call overwrites the same hash, transitioning queued→running.
    """
    if redis_client is None:
        return
    try:
        mapping: dict[str, str] = {
            "status": status,
            "done": "0",
            "total": str(total),
            "failed": "0",
            "errors": "[]",
            "total_annotations_created": "0",
            "total_skipped_detections": "0",
            "skipped_by_class_json": "{}",
        }
        if kind is not None:
            mapping["kind"] = kind
        redis_client.hset(progress_key(job_id), mapping=mapping)
        redis_client.expire(progress_key(job_id), _PROGRESS_TTL_SECONDS)
    except Exception:
        pass


def prepare_progress(
    redis_client,
    job_id: str,
    total: int,
    *,
    kind: str | None = None,
) -> None:
    """Seed the progress hash at *enqueue* time with ``status="queued"``.

    Thin wrapper over :func:`init_progress`. Kept as its own name so
    enqueue call sites read intentionally and a future "queued vs
    preparing" split has one place to change. ``kind`` is forwarded so
    the SAM-switch active-batch guard can filter by batch type (see
    :func:`count_active_jobs`).
    """
    init_progress(redis_client, job_id, total, status="queued", kind=kind)


def count_assets_for_task(session: Session, task_id: uuid.UUID) -> int:
    """Cheap COUNT mirroring :func:`list_assets_for_task`'s row set, so
    the enqueue-time ``total`` matches the worker's ``len(assets)``
    exactly (the worker overwrites it on start anyway if assets changed
    in between)."""
    return int(
        session.execute(
            select(func.count()).select_from(Asset).where(Asset.task_id == task_id)
        ).scalar_one()
    )


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
    # Rolling TTL so a multi-day batch's hash never expires mid-run.
    _refresh_ttl(redis_client, job_id)


def finalize_progress(redis_client, job_id: str, *, status: str) -> None:
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), "status", status)
    except Exception:
        pass
    # Give the terminal state a fresh 24h window so the polling dialog
    # / post-batch toast can read the final status before Redis GCs it.
    _refresh_ttl(redis_client, job_id)


def write_error_traceback(redis_client, job_id: str, tb: str) -> None:
    """plan-09 task-09 — persist a worker's traceback into the progress hash.

    The frontend never surfaces this raw string; it's purely for ops
    triage when an RQ worker dies and the only forensic crumb is the
    Redis hash. Best-effort: a Redis blip must not mask the original
    exception that triggered the call.
    """
    if redis_client is None:
        return
    try:
        redis_client.hset(progress_key(job_id), "error_traceback", tb)
    except Exception:  # noqa: BLE001
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


# ---------------------------------------------------------------------------
# Resumable chunked-batch primitives.
#
# Historically every ``run_*_batch`` processed *all* assets in a single
# RQ execution under a fixed ``job_timeout``. Any dataset bigger than
# that window (e.g. a 3.6K / 20K / 100K SAM auto-annotate) was therefore
# guaranteed to be reaped by RQ's death penalty mid-run and never
# finish — that is exactly the failure that lost ~2/3 of a 3600-image
# batch at the 2h mark.
#
# These helpers turn the per-asset loop into a *resumable window*: each
# RQ execution attempts at most ``BATCH_CHUNK_WINDOW`` assets, persists a
# ``cursor`` (assets *attempted*, not merely succeeded) into the same
# ``aa:job:`` progress hash, then re-enqueues the SAME runner for the
# next window. Total wall-clock is unbounded — the per-chunk timeout is
# now only a *hung-asset watchdog*, and a chunk that does trip it (or is
# SIGKILLed by a deploy) is retried by RQ and resumes from the cursor.
# ``done`` / ``failed`` / aggregates are seeded back from the hash so
# they accumulate across chunks; ``status`` stays ``running`` for the
# whole logical batch so the SAM-switch guard keeps gating and the
# polling dialog shows continuous progress.
# ---------------------------------------------------------------------------

# Assets attempted per RQ execution. Small enough that a chunk finishes
# (and re-enqueues) long before any sane per-chunk timeout, so a
# deploy/restart redoes at most ~this many assets — and even those are
# cheap re-runs because already-committed annotations are durable.
BATCH_CHUNK_WINDOW = 200

_CURSOR_FIELD = "cursor"


class _SkipAsset(Exception):
    """Internal: a per-asset early-skip (e.g. a video with no extracted
    frames) that still counts as *attempted*. Raising it lets the
    windowed loop fall through to the uniform progress/cursor tail
    instead of a bare ``continue`` that would bypass the cursor write."""


def _b2s(v):
    """Decode a Redis value regardless of the client's ``decode_responses``
    setting (text/visual batches use a decoding client; yoloe/predict use
    a bytes client)."""
    return v.decode("utf-8", "ignore") if isinstance(v, (bytes, bytearray)) else v


def read_cursor(redis_client, job_id: str) -> int | None:
    """Assets *attempted* so far, or ``None`` when the cursor field is
    absent (⇒ first chunk; progress not initialised yet). Best-effort: a
    Redis hiccup returns ``None`` so the batch restarts from 0 rather
    than wedging."""
    if redis_client is None:
        return None
    try:
        raw = redis_client.hget(progress_key(job_id), _CURSOR_FIELD)
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    try:
        return int(_b2s(raw))
    except (TypeError, ValueError):
        return None


def write_cursor(redis_client, job_id: str, cursor: int) -> None:
    """Persist the attempted-asset cursor so a crashed/timed-out chunk
    resumes here instead of re-doing the whole batch. Best-effort."""
    if redis_client is None:
        return
    try:
        redis_client.hset(
            progress_key(job_id), _CURSOR_FIELD, str(int(cursor))
        )
    except Exception:  # noqa: BLE001
        pass
    # Rolling TTL: keep the resume cursor alive for the whole multi-day
    # batch (see _refresh_ttl). Called every asset.
    _refresh_ttl(redis_client, job_id)


def _status_is_canceled(redis_client, job_id: str) -> bool:
    if redis_client is None:
        return False
    try:
        cur = redis_client.hget(progress_key(job_id), "status")
    except Exception:  # noqa: BLE001
        return False
    return _b2s(cur) == "canceled"


@dataclass
class ChunkPlan:
    """Where this RQ execution should start/stop within the batch."""

    cursor: int       # absolute index of the first asset to attempt
    window_end: int   # exclusive stop index for this execution
    total: int        # full asset count for the batch
    first: bool       # True ⇒ first chunk (progress initialised here)
    canceled: bool    # True ⇒ user already canceled; do no work


def begin_chunk(
    redis_client,
    job_id: str,
    *,
    total: int,
    kind: str,
    window: int = BATCH_CHUNK_WINDOW,
) -> ChunkPlan:
    """Resolve this execution's window and (only on the first chunk)
    initialise the progress hash.

    Honors the pre-init cancel race: if the user pressed Cancel while the
    job sat queued, ``status`` is already ``canceled`` in the hash and we
    must NOT ``init_progress`` over it — return ``canceled=True`` so the
    caller finalizes cleanly without doing any work.
    """
    if _status_is_canceled(redis_client, job_id):
        return ChunkPlan(
            cursor=0, window_end=0, total=total, first=False, canceled=True
        )
    cur = read_cursor(redis_client, job_id)
    if cur is None:
        # First chunk: initialise progress + seed cursor=0.
        init_progress(redis_client, job_id, total=total, kind=kind)
        write_cursor(redis_client, job_id, 0)
        cursor = 0
        first = True
    else:
        # Continuation: keep done/total/kind/aggregates intact; just
        # make sure status reads "running" again (a prior chunk may
        # have left it on "waiting_for_gpu"). NEVER re-init — that
        # would reset done back to 0.
        cursor = max(0, cur)
        first = False
        _set_progress_status(redis_client, job_id, "running")
    return ChunkPlan(
        cursor=cursor,
        window_end=min(cursor + max(1, window), total),
        total=total,
        first=first,
        canceled=False,
    )


def finish_chunk(
    redis_client,
    job_id: str,
    *,
    processed: int,
    total: int,
    failed: int,
    canceled: bool,
    runner,
    payload,
) -> str:
    """Terminate or continue the batch. Returns one of:

      ``"canceled"``               — user canceled; finalized.
      ``"completed"`` /
      ``"completed_with_errors"``  — every asset attempted; finalized.
      ``"continued"``              — more assets remain; cursor saved and
                                     the next window re-enqueued. Status
                                     is left ``running`` (NOT finalized)
                                     so the logical batch stays active
                                     across the whole continuation chain.
    """
    write_cursor(redis_client, job_id, processed)
    if canceled:
        finalize_progress(redis_client, job_id, status="canceled")
        return "canceled"
    if processed >= total:
        status = "completed" if failed == 0 else "completed_with_errors"
        finalize_progress(redis_client, job_id, status=status)
        return status
    # More work remains — hand the next window to a fresh RQ job. The
    # progress hash (cursor/done/aggregates) is the source of truth; the
    # new job reads it and resumes.
    try:
        from carve_api.jobs.queue import enqueue_batch_continuation

        enqueue_batch_continuation(runner, payload, chunk_index=processed)
    except Exception:  # noqa: BLE001
        # The chunk that just ran already committed its work and saved
        # its cursor. Re-raise so RQ's Retry re-runs THIS job, which
        # resumes from the cursor and re-attempts the continuation —
        # better than a silently stalled batch.
        log.exception(
            "batch.continuation.enqueue_failed job_id=%s next_cursor=%d",
            job_id,
            processed,
        )
        raise
    return "continued"


# v3.32 -- statuses that count as "the worker is doing things with the
# GPU/model right now" for the SAM-switch guard. ``queued`` is included
# so a switch request just before the worker picks up the job still
# refuses (otherwise the switch would race the worker into a
# variant-mismatch failure within seconds).
_ACTIVE_JOB_STATUSES: frozenset[str] = frozenset(
    {"queued", "running", "waiting_for_gpu"}
)

# v3.32 -- which batch kinds actually drive the SAM model. YOLO and
# YOLOE batches use their own weights and do NOT call SAM, so switching
# the SAM variant while a YOLO batch is running is safe and must NOT
# trigger the active-batch gate. Frontend-driven post-process passes
# (sam-refine-batch, polygon-convert) never write to this Redis hash,
# so they're enumerated separately by the frontend's same-user warning
# and intentionally absent here.
SAM_USING_BATCH_KINDS: frozenset[str] = frozenset(
    {"sam-auto-text", "sam-auto-visual"}
)


def count_active_jobs(
    redis_client,
    *,
    kinds: frozenset[str] | None = None,
) -> list[dict]:
    """v3.32 -- enumerate the auto-annotate batch jobs that are currently
    holding (or about to hold) the model service's inference slot.

    Returns a list of small dicts: ``{job_id, kind, status, done, total}``.
    An empty list means "no matching jobs". Soft-fails when Redis is
    unavailable: returns ``[]`` so a Redis blip doesn't permanently
    block users from changing SAM variants. The router's business-logic
    gate is the authoritative source of truth; this helper only
    enumerates.

    Pass ``kinds`` to filter to a subset of batch kinds (e.g.
    :data:`SAM_USING_BATCH_KINDS` for the SAM-switch gate). When
    ``kinds`` is None, every active job is returned regardless of
    kind. Legacy jobs queued before kind tracking was added carry no
    ``kind`` field; they are conservatively included when a filter is
    applied so the gate doesn't accidentally race a job whose kind we
    don't know.

    Scans ``aa:job:*`` and filters by status. ``scan_iter`` is used
    over ``keys()`` so even a Redis with tens of thousands of stale
    keys doesn't block the gunicorn worker for seconds; the trade-off
    is that newly-created keys mid-scan may be missed, which is
    acceptable here because the worker writes status before claiming
    work and the model service's own admission gate is the final
    safety net.
    """
    if redis_client is None:
        return []
    out: list[dict] = []
    try:
        for raw_key in redis_client.scan_iter(
            match=f"{_PROGRESS_KEY_PREFIX}*", count=100
        ):
            try:
                key = (
                    raw_key.decode() if isinstance(raw_key, bytes) else raw_key
                )
                if not key.startswith(_PROGRESS_KEY_PREFIX):
                    continue
                raw = redis_client.hgetall(raw_key)
            except Exception:  # noqa: BLE001
                continue
            if not raw:
                continue

            def _b2s(v):
                return v.decode() if isinstance(v, bytes) else v

            parsed = {_b2s(k): _b2s(v) for k, v in raw.items()}
            status = parsed.get("status", "")
            if status not in _ACTIVE_JOB_STATUSES:
                continue
            job_kind = parsed.get("kind") or None
            if kinds is not None and job_kind is not None and job_kind not in kinds:
                # Skip jobs whose kind is recorded AND not in the
                # caller's allow-set. Jobs missing a kind (pre-v3.32)
                # fall through so we never accidentally race them.
                continue
            out.append(
                {
                    "job_id": key[len(_PROGRESS_KEY_PREFIX) :],
                    "kind": job_kind,
                    "status": status,
                    "done": int(parsed.get("done", 0) or 0),
                    "total": int(parsed.get("total", 0) or 0),
                }
            )
    except Exception:  # noqa: BLE001 -- Redis must never wedge the gate
        return []
    return out


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
    # v3.21+ — VLM-FO1 precision filter opt-in for the entire batch.
    # Default False ensures payloads pickled before this field exists
    # still deserialize (dataclass default kicks in).
    use_vlm_fo1: bool = False
    # Bbox-IoU floor for the per-class NMS dedup pass. None = server
    # default. Default None so payloads pickled before this field
    # existed still deserialize via the dataclass default.
    iou_threshold: float | None = None
    # Douglas-Peucker tolerance for the polygon simplification. None
    # keeps the polygonize default. Default None preserves backwards
    # compat with payloads pickled before this field existed.
    epsilon_factor: float | None = None
    # v3.31 — optional subset filter (see BatchJobPayload.asset_ids).
    asset_ids: list[str] | None = None
    # v3.31 — cross-class hierarchical NMS (see BatchJobPayload).
    resolve_hierarchy: bool = False
    hierarchy_iou: float = 0.7
    # v3.33 -- cross-class winner-takes-all NMS; orthogonal to the
    # hierarchy resolver. OFF by default for backward compat. Pickled
    # payloads from before this field existed will deserialize via the
    # dataclass default.
    resolve_cross_class: bool = False
    cross_class_iou: float = 0.7


def build_auto_text_payload(
    *,
    actor: User,
    task: Task,
    class_ids: list[uuid.UUID],
    threshold: float,
    find_all: bool,
    overwrite: bool,
    use_vlm_fo1: bool = False,
    iou_threshold: float | None = None,
    epsilon_factor: float | None = None,
    asset_ids: list[str] | None = None,
    resolve_hierarchy: bool = False,
    hierarchy_iou: float = 0.7,
    resolve_cross_class: bool = False,
    cross_class_iou: float = 0.7,
) -> AutoTextBatchPayload:
    return AutoTextBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        class_ids=[str(c) for c in class_ids],
        threshold=float(threshold),
        find_all=bool(find_all),
        overwrite=bool(overwrite),
        use_vlm_fo1=bool(use_vlm_fo1),
        iou_threshold=(
            float(iou_threshold) if iou_threshold is not None else None
        ),
        epsilon_factor=(
            float(epsilon_factor) if epsilon_factor is not None else None
        ),
        asset_ids=list(asset_ids) if asset_ids else None,
        resolve_hierarchy=bool(resolve_hierarchy),
        hierarchy_iou=float(hierarchy_iou),
        resolve_cross_class=bool(resolve_cross_class),
        cross_class_iou=float(cross_class_iou),
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

    session = get_session_factory()()
    # Default "failed" so the FO1 unload in ``finally`` treats an early
    # crash as terminal (frees the GPU); only a true "continued" leaves
    # the weights resident for the next window.
    result_status = "failed"
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
        assets = _filter_assets_by_ids(
            assets, getattr(payload, "asset_ids", None)
        )

        # Seed running totals from the hash so a resumed chunk continues
        # the counts instead of resetting them. First chunk → all zeros.
        carry = read_progress(redis_client, payload.job_id)
        total_created = int(carry.get("total_annotations_created", 0) or 0)
        failed = int(carry.get("failed", 0) or 0)
        errors: list[str] = list(carry.get("errors", []) or [])

        plan = begin_chunk(
            redis_client,
            payload.job_id,
            total=len(assets),
            kind="sam-auto-text",
        )
        if plan.canceled:
            result_status = finish_chunk(
                redis_client,
                payload.job_id,
                processed=plan.cursor,
                total=plan.total,
                failed=failed,
                canceled=True,
                runner=run_auto_text_batch,
                payload=payload,
            )
            return {
                "ok": True,
                "canceled": True,
                "annotations_created": total_created,
                "failed": failed,
            }

        canceled = False
        i = plan.cursor
        while i < plan.window_end:
            # Co-operative cancel: the API's cancel endpoint writes
            # status="canceled" to the hash. Per-asset commits ensure
            # all work done so far is preserved.
            if _status_is_canceled(redis_client, payload.job_id):
                canceled = True
                break
            asset = assets[i]
            try:
                result = _run_with_admission_retry(
                    lambda: auto_text_for_asset(
                        session=session,
                        asset=asset,
                        task=task,
                        classes=classes,
                        threshold=payload.threshold,
                        find_all=payload.find_all,
                        overwrite=payload.overwrite,
                        actor_id=actor_uuid,
                        use_vlm_fo1=getattr(payload, "use_vlm_fo1", False),
                        iou_threshold=getattr(payload, "iou_threshold", None),
                        epsilon_factor=getattr(payload, "epsilon_factor", None),
                        resolve_hierarchy=getattr(
                            payload, "resolve_hierarchy", False
                        ),
                        hierarchy_iou=getattr(payload, "hierarchy_iou", 0.7),
                        resolve_cross_class=getattr(
                            payload, "resolve_cross_class", False
                        ),
                        cross_class_iou=getattr(
                            payload, "cross_class_iou", 0.7
                        ),
                    ),
                    redis_client=redis_client,
                    job_id=payload.job_id,
                    asset_label=str(asset.id),
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

            # Advance the attempted-asset cursor regardless of
            # success/failure so a permanently-failing asset can't trap
            # the batch in an infinite re-attempt loop.
            i += 1
            update_progress(
                redis_client,
                payload.job_id,
                done=i,
                failed=failed,
                errors=errors[-20:],
                total_annotations_created=total_created,
                total_skipped_detections=0,
                skipped_by_class={},
            )
            write_cursor(redis_client, payload.job_id, i)

        result_status = finish_chunk(
            redis_client,
            payload.job_id,
            processed=i,
            total=plan.total,
            failed=failed,
            canceled=canceled,
            runner=run_auto_text_batch,
            payload=payload,
        )
        return {
            "ok": True,
            "annotations_created": total_created,
            "failed": failed,
            "status": result_status,
            "continued": result_status == "continued",
            "canceled": result_status == "canceled",
        }
    finally:
        session.close()
        # v3.22 — when this batch opted into FO1, drop the sidecar's
        # ~6 GB of GPU weights once the batch is *terminal*. NOT between
        # continuation chunks ("continued") — unloading there would
        # thrash 6 GB of weights every window. The sidecar's idle
        # sweeper is the safety net. Best-effort; never raises.
        if result_status != "continued" and getattr(
            payload, "use_vlm_fo1", False
        ):
            try:
                from carve_api.inference.model_client import sam_vlm_fo1_unload
                sam_vlm_fo1_unload()
            except Exception:  # noqa: BLE001
                log.warning(
                    "auto_text_batch: post-batch FO1 unload failed",
                    exc_info=True,
                )


# v3.24 — SAM 3.1 visual-prompt batch. Reuses the Redis progress hash
# helpers (init/update/finalize/read) so the frontend's BatchProgressDialog
# works uniformly across YOLO, SAM-text, and SAM-visual batches.

@dataclass
class AutoVisualBatchPayload:
    """Serialisable args for the SAM 3.1 visual-prompt auto-annotate batch.

    ``sources`` is the same multi-source list shape the sync endpoint
    accepts; we keep it as plain dicts here so RQ pickles cleanly.
    """

    job_id: str
    actor_id: str
    task_id: str
    sources: list[dict]
    ref_kind: str
    threshold: float
    find_all: bool
    overwrite: bool
    # Douglas-Peucker tolerance for polygon simplification. None keeps
    # the polygonize default. Default None preserves backwards compat
    # with payloads pickled before this field existed.
    epsilon_factor: float | None = None
    # v3.31 — optional subset filter (see BatchJobPayload.asset_ids).
    asset_ids: list[str] | None = None
    # v3.31 — cross-class hierarchical NMS (see BatchJobPayload).
    resolve_hierarchy: bool = False
    hierarchy_iou: float = 0.7


def build_auto_visual_payload(
    *,
    actor: User,
    task: Task,
    sources: list[dict],
    ref_kind: str,
    threshold: float,
    find_all: bool,
    overwrite: bool,
    epsilon_factor: float | None = None,
    asset_ids: list[str] | None = None,
    resolve_hierarchy: bool = False,
    hierarchy_iou: float = 0.7,
) -> AutoVisualBatchPayload:
    return AutoVisualBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        sources=sources,
        ref_kind=str(ref_kind),
        threshold=float(threshold),
        find_all=bool(find_all),
        overwrite=bool(overwrite),
        epsilon_factor=(
            float(epsilon_factor) if epsilon_factor is not None else None
        ),
        asset_ids=list(asset_ids) if asset_ids else None,
        resolve_hierarchy=bool(resolve_hierarchy),
        hierarchy_iou=float(hierarchy_iou),
    )


def run_auto_visual_batch(payload: AutoVisualBatchPayload) -> dict:
    """RQ job entry point for the SAM 3.1 visual-prompt multi-asset batch.

    Mirrors run_auto_text_batch's session/commit semantics:
      - Single shared session for the whole batch.
      - Per-asset commit on success, per-asset rollback on failure.
      - Cooperative cancel: between assets, check the progress hash for
        ``status="canceled"`` written by the API's cancel endpoint.
    """
    import os

    import redis as _redis
    from carve_api.db import get_session_factory
    from carve_api.inference.auto_visual import auto_visual_for_asset

    redis_client = None
    try:
        redis_client = _redis.Redis(
            host=os.environ.get("REDIS_HOST", "redis"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "auto_visual_batch: redis init failed; running without progress"
        )

    task_uuid = uuid.UUID(payload.task_id)
    actor_uuid = uuid.UUID(payload.actor_id)

    session = get_session_factory()()
    try:
        task = session.get(Task, task_uuid)
        if task is None:
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"ok": False, "error": "task_not_found"}

        assets = list_assets_for_task(session, task_uuid)
        assets = _filter_assets_by_ids(
            assets, getattr(payload, "asset_ids", None)
        )

        # Seed running totals from the hash so a resumed chunk continues
        # the counts instead of resetting them. First chunk → all zeros.
        carry = read_progress(redis_client, payload.job_id)
        total_created = int(carry.get("total_annotations_created", 0) or 0)
        failed = int(carry.get("failed", 0) or 0)
        errors: list[str] = list(carry.get("errors", []) or [])

        plan = begin_chunk(
            redis_client,
            payload.job_id,
            total=len(assets),
            kind="sam-auto-visual",
        )
        if plan.canceled:
            finish_chunk(
                redis_client,
                payload.job_id,
                processed=plan.cursor,
                total=plan.total,
                failed=failed,
                canceled=True,
                runner=run_auto_visual_batch,
                payload=payload,
            )
            return {
                "ok": True,
                "canceled": True,
                "annotations_created": total_created,
                "failed": failed,
            }

        canceled = False
        i = plan.cursor
        while i < plan.window_end:
            if _status_is_canceled(redis_client, payload.job_id):
                canceled = True
                break
            asset = assets[i]
            try:
                result = _run_with_admission_retry(
                    lambda: auto_visual_for_asset(
                        session=session,
                        asset=asset,
                        task=task,
                        sources=payload.sources,
                        ref_kind=payload.ref_kind,
                        threshold=payload.threshold,
                        find_all=payload.find_all,
                        overwrite=payload.overwrite,
                        actor_id=actor_uuid,
                        epsilon_factor=getattr(payload, "epsilon_factor", None),
                        resolve_hierarchy=getattr(
                            payload, "resolve_hierarchy", False
                        ),
                        hierarchy_iou=getattr(payload, "hierarchy_iou", 0.7),
                    ),
                    redis_client=redis_client,
                    job_id=payload.job_id,
                    asset_label=str(asset.id),
                )
                session.commit()
                total_created += int(result.get("annotations_created", 0))
            except (AppError, ModelServiceError) as exc:
                session.rollback()
                failed += 1
                errors.append(_truncated_repr(exc, limit=200))
                log.warning(
                    "auto_visual_batch: asset %s failed: %s",
                    asset.id,
                    _truncated_repr(exc),
                )
            except Exception as exc:  # noqa: BLE001
                session.rollback()
                failed += 1
                errors.append(_truncated_repr(exc, limit=200))
                log.exception("auto_visual_batch: asset %s unexpected error", asset.id)

            # Advance cursor on success OR failure so a permanently
            # failing asset can't trap the batch in a re-attempt loop.
            i += 1
            update_progress(
                redis_client,
                payload.job_id,
                done=i,
                failed=failed,
                errors=errors[-20:],
                total_annotations_created=total_created,
                total_skipped_detections=0,
                skipped_by_class={},
            )
            write_cursor(redis_client, payload.job_id, i)

        result_status = finish_chunk(
            redis_client,
            payload.job_id,
            processed=i,
            total=plan.total,
            failed=failed,
            canceled=canceled,
            runner=run_auto_visual_batch,
            payload=payload,
        )
        return {
            "ok": True,
            "annotations_created": total_created,
            "failed": failed,
            "status": result_status,
            "continued": result_status == "continued",
            "canceled": result_status == "canceled",
        }
    finally:
        session.close()


# v3.23 — YOLOE batch (text / visual / prompt-free) over all assets in a task.
# Reuses the same Redis progress hash + cooperative cancel pattern as the
# YOLO and SAM auto-text batches so the frontend's BackgroundJobsBar +
# polling overlay work uniformly.

@dataclass
class YoloeBatchPayload:
    """Serialisable args for the YOLOE RQ job.

    ``mode`` is the YoloeMode enum value as a string ("text", "visual",
    "prompt_free"). All mode-specific params live in ``params`` as a
    plain dict so RQ pickles cleanly across worker boundaries (the
    YoloeMode enum is a str subclass so its ``.value`` round-trips
    fine; we still re-build typed param objects in the worker).

    For visual mode, ``params["refer_b64"]`` carries the base64-encoded
    reference-image bytes the user supplied at enqueue time (the worker
    re-uses one reference for every asset in the batch).
    """

    job_id: str
    actor_id: str
    task_id: str
    mode: str
    params: dict
    overwrite: bool = False
    min_confidence: float | None = None
    # v3.23.4 — default flipped to "bbox" (previously "polygon"). Most
    # flows commit boxes first and refine to polygons via SAM later.
    # Older pickled payloads still deserialise via dataclass default.
    output_kind: str = "bbox"
    # v3.31 — optional subset filter (see BatchJobPayload.asset_ids).
    asset_ids: list[str] | None = None
    # v3.31 — cross-class hierarchical NMS (see BatchJobPayload).
    resolve_hierarchy: bool = False
    hierarchy_iou: float = 0.7


def build_yoloe_payload(
    *,
    actor: User,
    task: Task,
    mode: str,
    params: dict,
    overwrite: bool = False,
    min_confidence: float | None = None,
    output_kind: str = "bbox",
    asset_ids: list[str] | None = None,
    resolve_hierarchy: bool = False,
    hierarchy_iou: float = 0.7,
) -> YoloeBatchPayload:
    return YoloeBatchPayload(
        job_id=str(uuid.uuid4()),
        actor_id=str(actor.id),
        task_id=str(task.id),
        mode=mode,
        params=params,
        overwrite=overwrite,
        min_confidence=min_confidence,
        output_kind=output_kind,
        asset_ids=list(asset_ids) if asset_ids else None,
        resolve_hierarchy=bool(resolve_hierarchy),
        hierarchy_iou=float(hierarchy_iou),
    )


def run_yoloe_batch(payload: YoloeBatchPayload) -> dict:
    """RQ job entry: run YOLOE over every asset in a task.

    Mirrors ``run_batch_auto_annotate`` — single shared session, per-
    asset commit, cooperative cancel between assets via the Redis
    ``status`` flag. Per-asset failure increments ``failed`` and
    appends a short reason; the rest of the batch keeps going.

    Imports are inside the function so RQ workers without the full
    FastAPI app stack still pickle/unpickle cleanly.
    """
    import base64 as _b64
    import os
    from typing import Any

    import redis as _redis
    from carve_api.db import get_session_factory
    from carve_api.inference.autoannotate import fetch_asset_bytes
    from carve_api.inference.yoloe import (
        YoloeMode,
        YoloeOutputKind,
        YoloePromptFreeParams,
        YoloeTextParams,
        YoloeTextPrompt,
        YoloeVisualGroup,
        YoloeVisualParams,
        YoloeVisualSource,
        apply_yoloe_to_asset,
    )

    redis_client: Any = None
    try:
        redis_client = _redis.Redis(
            host=os.environ.get("REDIS_HOST", "redis"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
        )
    except Exception:  # noqa: BLE001
        log.exception("yoloe_batch: redis init failed; running without progress")

    try:
        mode = YoloeMode(payload.mode)
    except ValueError:
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {"ok": False, "error": f"bad_mode:{payload.mode}"}

    # Re-build typed params from the pickled dict.
    p = payload.params or {}
    typed_params: YoloeTextParams | YoloeVisualParams | YoloePromptFreeParams
    try:
        if mode is YoloeMode.text:
            # Each row is {"class_id": "<uuid>", "prompt": "<text>"}.
            prompt_items = list(p.get("prompts") or [])
            typed_prompts: list[YoloeTextPrompt] = []
            for item in prompt_items:
                if not isinstance(item, dict):
                    continue
                cid_raw = item.get("class_id")
                pr = (item.get("prompt") or "").strip()
                if not cid_raw or not pr:
                    continue
                typed_prompts.append(
                    YoloeTextPrompt(class_id=uuid.UUID(str(cid_raw)), prompt=pr),
                )
            if not typed_prompts:
                finalize_progress(
                    redis_client, payload.job_id, status="failed",
                )
                return {"ok": False, "error": "prompts_empty"}
            typed_params = YoloeTextParams(
                prompts=typed_prompts,
                conf=float(p.get("conf", 0.25)),
                iou=float(p.get("iou", 0.7)),
            )
        elif mode is YoloeMode.visual:
            # v3.24 — multi-source visual prompts. The payload either
            # carries the new ``sources: [{asset_id, groups}]`` shape
            # OR the legacy ``refer_asset_id`` / ``refer_b64`` +
            # top-level ``groups`` shape. Convert legacy → single
            # source, then fetch each source's bytes ONCE before the
            # per-target loop. With N sources × T targets, we already
            # pay N×T model calls; fetching from MinIO N×T times would
            # add minutes of avoidable overhead.
            from carve_api.assets.models import Asset as _A
            from carve_api.inference.autoannotate import (
                fetch_asset_bytes as _fetch,
            )

            # Normalise legacy single-source payloads to the new
            # ``sources`` shape so the rest of this branch is uniform.
            sources_in = list(p.get("sources") or [])
            if not sources_in and p.get("groups"):
                sources_in = [{
                    "asset_id": p.get("refer_asset_id"),
                    "groups": p.get("groups") or [],
                    "refer_b64": p.get("refer_b64") or "",
                }]

            typed_sources: list[YoloeVisualSource] = []
            boot = get_session_factory()()
            try:
                for s in sources_in:
                    if not isinstance(s, dict):
                        continue
                    src_groups: list[YoloeVisualGroup] = []
                    for g in (s.get("groups") or []):
                        if not isinstance(g, dict):
                            continue
                        cid_raw = g.get("class_id")
                        bx = g.get("bboxes") or []
                        if not cid_raw or not bx:
                            continue
                        src_groups.append(
                            YoloeVisualGroup(
                                class_id=uuid.UUID(str(cid_raw)),
                                bboxes=[list(b) for b in bx],
                            ),
                        )
                    if not src_groups:
                        continue

                    # Resolve this source's reference bytes:
                    #   1. inline ``refer_b64`` (legacy single-source)
                    #   2. fetch from MinIO via ``asset_id``
                    #   3. None → use target bytes per-target
                    refer_bytes_payload: bytes | None = None
                    raw_b64 = s.get("refer_b64") or ""
                    if raw_b64:
                        try:
                            refer_bytes_payload = _b64.b64decode(raw_b64)
                        except Exception:  # noqa: BLE001
                            refer_bytes_payload = None
                    src_asset_id_raw = s.get("asset_id")
                    src_asset_id_uuid: uuid.UUID | None = None
                    if src_asset_id_raw:
                        try:
                            src_asset_id_uuid = uuid.UUID(str(src_asset_id_raw))
                        except (TypeError, ValueError):
                            src_asset_id_uuid = None
                    if (
                        refer_bytes_payload is None
                        and src_asset_id_uuid is not None
                    ):
                        ra = boot.get(_A, src_asset_id_uuid)
                        if ra is not None:
                            refer_bytes_payload = _fetch(ra)
                        # Missing source asset → skip; partial run is
                        # better than aborting the whole batch on a
                        # single deleted reference.

                    typed_sources.append(
                        YoloeVisualSource(
                            asset_id=src_asset_id_uuid,
                            refer_bytes=refer_bytes_payload,
                            groups=src_groups,
                        ),
                    )
            finally:
                boot.close()

            if not typed_sources:
                finalize_progress(
                    redis_client, payload.job_id, status="failed",
                )
                return {"ok": False, "error": "no_valid_sources"}

            typed_params = YoloeVisualParams(
                sources=typed_sources,
                conf=float(p.get("conf", 0.25)),
                iou=float(p.get("iou", 0.7)),
            )
        else:  # prompt_free
            ann_as = p.get("annotate_as_class_id")
            typed_params = YoloePromptFreeParams(
                annotate_as_class_id=uuid.UUID(ann_as) if ann_as else None,
                conf=float(p.get("conf", 0.25)),
                iou=float(p.get("iou", 0.7)),
                max_detections=p.get("max_detections"),
            )
    except (KeyError, ValueError, TypeError) as exc:
        log.exception("yoloe_batch: bad params")
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {"ok": False, "error": f"bad_params:{exc}"}

    actor_uuid = uuid.UUID(payload.actor_id)
    task_uuid = uuid.UUID(payload.task_id)
    min_conf = (
        max(0.0, min(1.0, float(payload.min_confidence)))
        if payload.min_confidence is not None
        else 0.0
    )

    session = get_session_factory()()
    try:
        actor = session.get(User, actor_uuid)
        task = session.get(Task, task_uuid)
        if actor is None or task is None:
            finalize_progress(redis_client, payload.job_id, status="failed")
            return {"ok": False, "error": "missing_actor_or_task"}

        assets = _list_assets_for_task(session, task_uuid)
        assets = _filter_assets_by_ids(
            assets, getattr(payload, "asset_ids", None)
        )

        # Seed counts/aggregates from the hash so a resumed chunk
        # continues the running totals instead of resetting them. First
        # chunk → all zeros (prepare_progress seeded the hash at enqueue).
        carry = read_progress(redis_client, payload.job_id)
        counts = {
            "done": int(carry.get("done", 0) or 0),
            "failed": int(carry.get("failed", 0) or 0),
        }
        aggregates: dict = {
            "total_annotations_created": int(
                carry.get("total_annotations_created", 0) or 0
            ),
            "total_skipped_detections": int(
                carry.get("total_skipped_detections", 0) or 0
            ),
            "skipped_by_class": dict(carry.get("skipped_by_class", {}) or {}),
        }
        errors: list[str] = list(carry.get("errors", []) or [])

        # begin_chunk also absorbs the v3.23.5 pre-init cancel race
        # (status already "canceled" while queued): it returns
        # canceled=True WITHOUT re-initialising the hash.
        plan = begin_chunk(
            redis_client,
            payload.job_id,
            total=len(assets),
            kind="yoloe-batch",
        )
        if plan.canceled:
            finish_chunk(
                redis_client,
                payload.job_id,
                processed=plan.cursor,
                total=plan.total,
                failed=counts["failed"],
                canceled=True,
                runner=run_yoloe_batch,
                payload=payload,
            )
            return {"ok": True, "canceled": True, **counts, **aggregates}

        canceled = False
        i = plan.cursor
        while i < plan.window_end:
            if _status_is_canceled(redis_client, payload.job_id):
                canceled = True
                break
            asset = assets[i]
            try:
                # Videos: use the first extracted frame JPEG (idx=0) so
                # the model service receives an image, not an mp4. Image
                # assets feed their original blob.
                frame_id = None
                if getattr(asset, "kind", None) == "video":
                    from carve_api.assets.models import Frame

                    f = session.execute(
                        select(Frame).where(Frame.asset_id == asset.id).order_by(Frame.idx).limit(1)
                    ).scalar_one_or_none()
                    if f is None:
                        counts["failed"] += 1
                        errors.append(f"{asset.original_name}: video_no_frames_extracted")
                        raise _SkipAsset
                    frame_id = f.id
                image_bytes = fetch_asset_bytes(asset, frame_id=frame_id)

                aa_result = _run_with_admission_retry(
                    lambda: apply_yoloe_to_asset(
                        session=session,
                        actor=actor,
                        task=task,
                        asset=asset,
                        image_bytes=image_bytes,
                        mode=mode,
                        params=typed_params,
                        overwrite=payload.overwrite,
                        min_confidence=min_conf,
                        output_kind=YoloeOutputKind(
                            getattr(payload, "output_kind", "polygon"),
                        ),
                        resolve_hierarchy=getattr(
                            payload, "resolve_hierarchy", False
                        ),
                        hierarchy_iou=getattr(payload, "hierarchy_iou", 0.7),
                    ),
                    redis_client=redis_client,
                    job_id=payload.job_id,
                    asset_label=str(asset.id),
                )
                session.commit()
                counts["done"] += 1
                created = int(getattr(aa_result, "annotations_created", 0) or 0)
                skipped = int(getattr(aa_result, "skipped_count", 0) or 0)
                aggregates["total_annotations_created"] += created
                aggregates["total_skipped_detections"] += skipped
                per_skipped = getattr(aa_result, "skipped_by_class", None)
                if isinstance(per_skipped, dict):
                    bucket: dict[str, int] = aggregates["skipped_by_class"]
                    for k, v in per_skipped.items():
                        try:
                            n = int(v)
                        except (TypeError, ValueError):
                            continue
                        if n <= 0:
                            continue
                        bucket[str(k)] = bucket.get(str(k), 0) + n
            except _SkipAsset:
                # Already counted as failed above; fall through to the
                # uniform progress + cursor tail so the batch advances.
                pass
            except AppError as exc:
                try:
                    session.rollback()
                except Exception:  # noqa: BLE001
                    pass
                counts["failed"] += 1
                errors.append(f"{asset.original_name}: {exc.code}")
                log.warning(
                    "yoloe_batch.asset.failed.app_error job_id=%s asset_id=%s code=%s",
                    payload.job_id, asset.id, exc.code,
                )
            except Exception as exc:  # noqa: BLE001
                try:
                    session.rollback()
                except Exception:  # noqa: BLE001
                    pass
                counts["failed"] += 1
                errors.append(f"{asset.original_name}: {type(exc).__name__}")
                log.exception(
                    "yoloe_batch.asset.failed.unexpected job_id=%s asset_id=%s",
                    payload.job_id, asset.id,
                )

            # Advance the attempted cursor on every outcome (success,
            # skip, failure) so neither a poison asset nor a frameless
            # video can trap the batch in an endless re-attempt loop.
            i += 1
            update_progress(
                redis_client, payload.job_id, **counts,
                errors=errors[-50:], **aggregates,
            )
            write_cursor(redis_client, payload.job_id, i)

        result_status = finish_chunk(
            redis_client,
            payload.job_id,
            processed=i,
            total=plan.total,
            failed=counts["failed"],
            canceled=canceled,
            runner=run_yoloe_batch,
            payload=payload,
        )
        return {
            "ok": True,
            **counts,
            **aggregates,
            "status": result_status,
            "continued": result_status == "continued",
            "canceled": result_status == "canceled",
        }
    finally:
        session.close()


def _list_assets_for_task(session: Session, task_id: uuid.UUID) -> list[Asset]:
    """Internal alias used inside ``run_yoloe_batch`` to avoid the
    forward-reference issue caused by inserting the worker above
    ``list_assets_for_task`` in this file. Mirrors the public helper.
    """
    return list(
        session.execute(
            select(Asset)
            .where(Asset.task_id == task_id)
            # ``Asset.id`` tiebreaker is REQUIRED for chunked batches:
            # the windowed loop resumes by integer cursor across ~N/200
            # *separate* worker processes, so the asset order must be
            # byte-for-byte identical every chunk. ``created_at`` alone
            # is non-deterministic under ties (bulk uploads stamp many
            # rows with the same timestamp) — without the tiebreaker a
            # 100K run could skip or double-process assets.
            .order_by(Asset.created_at, Asset.id)
        ).scalars()
    )


def list_assets_for_task(session: Session, task_id: uuid.UUID) -> list[Asset]:
    return list(
        session.execute(
            select(Asset)
            .where(Asset.task_id == task_id)
            # Deterministic order across chunks — see _list_assets_for_task.
            .order_by(Asset.created_at, Asset.id)
        ).scalars()
    )


def _filter_assets_by_ids(
    assets: list[Asset], asset_ids: list[str] | None
) -> list[Asset]:
    """v3.31 — restrict a task asset list to the subset selected by the
    user's "Range: from N to M" scope. ``asset_ids`` is a non-empty list
    of UUID strings coming from the wire payload; ``None`` keeps the
    full list (legacy "all assets" behaviour).

    Preserves the canonical ``Asset.created_at`` order — we only filter
    ``assets`` in-place rather than ordering by the wire list, so two
    runs over the same range hit the same assets in the same order
    regardless of how the client serialised the ids.
    """
    if not asset_ids:
        return assets
    wanted: set[str] = {str(a) for a in asset_ids if a}
    if not wanted:
        return assets
    return [a for a in assets if str(a.id) in wanted]


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
    # Seed counts/aggregates from the hash so a *resumed* chunk continues
    # the running totals instead of resetting them. First chunk → all
    # zeros (the enqueue endpoint's prepare_progress seeded the hash).
    # v3.7.4 — also track per-class skip counts so the post-batch toast
    # can name the dominant unmapped classes (e.g. "person (412), boat (305)")
    # instead of just an opaque "Skipped N detections" number.
    _carry = read_progress(redis_client, payload.job_id)
    counts = {
        "done": int(_carry.get("done", 0) or 0),
        "failed": int(_carry.get("failed", 0) or 0),
    }
    aggregates: dict = {
        "total_annotations_created": int(
            _carry.get("total_annotations_created", 0) or 0
        ),
        "total_skipped_detections": int(
            _carry.get("total_skipped_detections", 0) or 0
        ),
        "skipped_by_class": dict(_carry.get("skipped_by_class", {}) or {}),
    }
    errors: list[str] = list(_carry.get("errors", []) or [])

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
                init_progress(
                    redis_client,
                    payload.job_id,
                    0,
                    kind="yolo-predict-batch",
                )
                finalize_progress(redis_client, payload.job_id, status="failed")
                return {"status": "failed", "done": 0, "total": 0, "failed": 0}

            assets = list_assets_for_task(boot, task.id)
            assets = _filter_assets_by_ids(
                assets, getattr(payload, "asset_ids", None)
            )
            asset_ids = [a.id for a in assets]
            asset_names_by_id = {a.id: a.original_name for a in assets}
            # NOTE: progress init is deferred to begin_chunk() below so a
            # *continuation* chunk doesn't reset done/cursor. (The
            # missing-refs / boot-failure paths above still init+finalize
            # to "failed" because those are terminal.)

            # Compute the presigned URL once (cheap; reused per asset).
            url = presigned_url_for_weight(weight)
    except Exception as exc:  # noqa: BLE001
        log.exception("batch.boot.failed job_id=%s", payload.job_id)
        init_progress(
            redis_client,
            payload.job_id,
            0,
            kind="yolo-predict-batch",
        )
        write_error_traceback(redis_client, payload.job_id, traceback.format_exc())
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
        # plan-09 task-09 — wrap the single yolo_load call in run_with_retry
        # so a model service still warming up (503) doesn't kill the entire
        # batch on the first blip.
        from carve_api.jobs.retry import run_with_retry

        run_with_retry(yolo_load, str(weight_uuid), url)
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
        write_error_traceback(redis_client, payload.job_id, traceback.format_exc())
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
        write_error_traceback(redis_client, payload.job_id, traceback.format_exc())
        session.close()
        finalize_progress(redis_client, payload.job_id, status="failed")
        return {
            "status": "failed",
            "done": 0,
            "total": len(asset_ids),
            "failed": 0,
            "errors": [f"weight_load_failed_at_start: {type(exc).__name__}"],
        }

    total = len(asset_ids)
    # begin_chunk also absorbs the pre-init cancel race (status already
    # "canceled" while queued) — it returns canceled WITHOUT re-init.
    plan = begin_chunk(
        redis_client,
        payload.job_id,
        total=total,
        kind="yolo-predict-batch",
    )
    if plan.canceled:
        session.close()
        finish_chunk(
            redis_client,
            payload.job_id,
            processed=plan.cursor,
            total=plan.total,
            failed=counts["failed"],
            canceled=True,
            runner=run_batch_auto_annotate,
            payload=payload,
        )
        return {
            "status": "canceled",
            **counts,
            "total": total,
            "errors": errors[-50:],
            **aggregates,
        }

    canceled = False
    try:
        i = plan.cursor
        while i < plan.window_end:
            asset_id = asset_ids[i]
            # v3.22 — co-operative cancel between assets, mirroring
            # ``run_auto_text_batch``. The cancel endpoint sets the
            # Redis hash status to "canceled"; we break here so the
            # in-flight asset (already committed) is preserved.
            if _status_is_canceled(redis_client, payload.job_id):
                canceled = True
                break

            original_name = asset_names_by_id.get(asset_id, str(asset_id))
            try:
                asset_db = session.get(Asset, asset_id)
                if asset_db is None:
                    # Asset was deleted between list and process. Count
                    # it failed and skip to the uniform progress/cursor
                    # tail (so the cursor still advances past it).
                    counts["failed"] += 1
                    errors.append(f"{original_name}: asset_not_found")
                    log.warning(
                        "batch.asset.missing job_id=%s asset_id=%s name=%s",
                        payload.job_id,
                        asset_id,
                        original_name,
                    )
                    raise _SkipAsset

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
                # v3.31 -- thread hierarchy NMS flags through the per-asset
                # call. getattr keeps older pickled payloads (without these
                # fields) compatible.
                aa_kwargs["resolve_hierarchy"] = getattr(
                    payload, "resolve_hierarchy", False
                )
                aa_kwargs["hierarchy_iou"] = getattr(
                    payload, "hierarchy_iou", 0.7
                )
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
            except _SkipAsset:
                # Already counted as failed above; fall through to the
                # uniform progress + cursor tail so the batch advances.
                pass
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

            # Advance the attempted cursor on every outcome so a poison
            # asset / missing asset can't trap the batch forever.
            i += 1
            update_progress(
                redis_client,
                payload.job_id,
                **counts,
                errors=errors,
                **aggregates,
            )
            write_cursor(redis_client, payload.job_id, i)
    finally:
        session.close()

    final_status = finish_chunk(
        redis_client,
        payload.job_id,
        processed=i,
        total=total,
        failed=counts["failed"],
        canceled=canceled,
        runner=run_batch_auto_annotate,
        payload=payload,
    )
    log.info(
        "batch.done job_id=%s status=%s done=%d failed=%d total=%d "
        "created=%d skipped=%d errors=%s",
        payload.job_id,
        final_status,
        counts["done"],
        counts["failed"],
        total,
        aggregates["total_annotations_created"],
        aggregates["total_skipped_detections"],
        _truncated_repr(errors),
    )
    return {
        "status": final_status,
        **counts,
        "total": total,
        "errors": errors[-50:],
        **aggregates,
    }
