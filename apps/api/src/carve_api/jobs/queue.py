# Armin Mehri — mehri.armin@gmail.com
"""RQ queue + enqueue helpers (plan-09 task-09).

``enqueue_with_defaults`` wraps ``Queue.enqueue`` so every enqueue site
gets the same TTLs, a per-callable ``job_timeout``, and a per-callable
*priority queue*, instead of each caller hand-rolling these (and
disagreeing).

Priority lanes (worker drains them in order ``high default low``):

    high      user-blocking inference batches (auto-text / predict /
              auto-visual / yoloe). A foreground dialog polls these, so
              they must not sit behind background work.
    default   import / export / frame-extraction / retrain — async,
              nobody is staring at a spinner waiting on the next tick.
    low       thumbnail + video-probe jobs. One is enqueued per uploaded
              asset, so a bulk upload floods this lane with hundreds of
              ~0.4s jobs. Keeping them off ``default`` stops that flood
              from starving the inference batches above (the priority
              inversion that made "auto-annotate all assets" hang at
              "Initialising…" forever behind the upload backlog).

Per-callable timeouts (seconds):

    run_batch_auto_annotate     2 * 3600    (predict-batch — slow)
    run_auto_text_batch         2 * 3600    (SAM-text batch)
    extract_frames_for_video    30 * 60     (frames extraction)
    run_retrain_job             24 * 3600   (training is the long pole)

Unknown callables fall back to RQ's default timeout and the ``default``
lane. Callers may also pass an explicit ``job_timeout`` kwarg, which
always wins.
"""

from __future__ import annotations

from typing import Any, Callable

from redis import Redis
from rq import Queue
from rq.job import Job

from carve_api.config import get_settings


# Per-callable job_timeout (seconds). Keep keys as bare callable names so
# the table doesn't import the worker modules at queue.py import time
# (the FastAPI app shouldn't pull in heavy worker deps just to enqueue).
_JOB_TIMEOUTS: dict[str, int] = {
    "run_batch_auto_annotate": 2 * 3600,
    "run_auto_text_batch": 2 * 3600,
    "extract_frames_for_video": 30 * 60,
    "run_retrain_job": 24 * 3600,
}

# Per-callable priority lane. Keys are bare callable names (same
# rationale as _JOB_TIMEOUTS — no worker-module imports at enqueue
# time). Anything not listed rides the ``default`` lane.
_QUEUE_HIGH = "high"
_QUEUE_DEFAULT = "default"
_QUEUE_LOW = "low"
_JOB_QUEUES: dict[str, str] = {
    # User-blocking inference batches — a foreground dialog polls these.
    "run_auto_text_batch": _QUEUE_HIGH,
    "run_batch_auto_annotate": _QUEUE_HIGH,
    "run_auto_visual_batch": _QUEUE_HIGH,
    "run_yoloe_batch": _QUEUE_HIGH,
    # Background fan-out — one per uploaded asset, floods on bulk upload.
    "generate_image_thumbnail": _QUEUE_LOW,
    "probe_video_metadata": _QUEUE_LOW,
}

# Sensible defaults applied to every enqueue.
_DEFAULT_RESULT_TTL = 86400      # 24h — keep job result for polling
_DEFAULT_FAILURE_TTL = 86400     # 24h — keep failure traceback for triage


def get_queue() -> Queue:
    s = get_settings()
    return Queue("default", connection=Redis(host=s.redis_host, port=s.redis_port))


def _callable_name(fn: Any) -> str:
    return getattr(fn, "__name__", "") or str(fn)


def enqueue_with_defaults(
    queue: Queue,
    fn: Callable[..., Any],
    *args: Any,
    **kwargs: Any,
) -> Job:
    """Enqueue ``fn(*args)`` on ``queue`` with sensible defaults.

    Defaults injected (caller can override by passing the same kwarg):

      * ``result_ttl=86400``   — keep job result for 24h
      * ``failure_ttl=86400``  — keep failure record for 24h
      * ``job_timeout``        — looked up by ``fn.__name__`` from the
                                 per-callable timeout table at the top
                                 of this module. If the callable name is
                                 unknown, RQ's default applies.

    Any extra ``**kwargs`` are forwarded to ``Queue.enqueue`` so callers
    can still pass ``job_id``, ``depends_on``, ``description``, etc.

    The ``queue`` argument only supplies the Redis *connection*: the
    actual lane is derived from the callable via ``_JOB_QUEUES`` so every
    call site routes consistently without each having to know the
    priority topology. Pass ``queue=Queue("default", ...)`` everywhere;
    this function moves the job to ``high``/``low`` as needed.
    """
    kwargs.setdefault("result_ttl", _DEFAULT_RESULT_TTL)
    kwargs.setdefault("failure_ttl", _DEFAULT_FAILURE_TTL)

    name = _callable_name(fn)
    if "job_timeout" not in kwargs:
        timeout = _JOB_TIMEOUTS.get(name)
        if timeout is not None:
            kwargs["job_timeout"] = timeout

    target_lane = _JOB_QUEUES.get(name, _QUEUE_DEFAULT)
    if target_lane != queue.name:
        queue = Queue(target_lane, connection=queue.connection)

    return queue.enqueue(fn, *args, **kwargs)


# Priority lanes the worker drains, highest first. Single source of
# truth for both enumeration order and the reprioritize destination.
_LANES = (_QUEUE_HIGH, _QUEUE_DEFAULT, _QUEUE_LOW)


def try_cancel_rq_job(client, rq_job_id: str) -> None:
    """Best-effort cancel of an enqueued/running RQ job.

    Two independent mechanisms — a job is in exactly one of these
    states, and each step is a no-op (swallowed) for the other:

    1. ``Job.cancel()`` — the job is still **queued** (worker hasn't
       picked it up). This *removes it from the queue* so the worker
       never runs it. Without this a "Cancel" on a not-yet-started
       batch did nothing: a cooperative Redis flag is overwritten by
       the worker's ``init_progress`` the instant it starts, so the
       job ran to completion anyway.

    2. ``send_stop_job_command`` — the job is **already executing**.
       This interrupts its in-flight work so the single worker frees
       up immediately. For batch jobs the caller also sets the
       cooperative Redis ``canceled`` flag (source of truth for "keep
       already-committed work" at the next per-asset checkpoint).

    Tolerates: missing job (finished/expired), worker not listening,
    RQ refusing the op for the job's current state, older RQ versions.
    """
    try:
        from rq.job import Job  # type: ignore

        Job.fetch(rq_job_id, connection=client).cancel()
    except Exception:  # noqa: BLE001
        pass
    try:
        from rq.command import send_stop_job_command  # type: ignore

        send_stop_job_command(client, rq_job_id)
    except Exception:  # noqa: BLE001
        pass


def try_reprioritize_rq_job(
    client, rq_job_id: str, dest: str = _QUEUE_HIGH
) -> str:
    """Move a still-**queued** job to the ``dest`` lane so it runs next.

    Returns one of: ``"moved"`` (re-queued onto ``dest``),
    ``"already"`` (already on ``dest``), ``"not_queued"`` (running /
    finished / missing — nothing to reorder), ``"error"``.

    A running job can't be reprioritized — by the time it's executing
    the worker is already on it. Only queued jobs can jump the line.
    """
    try:
        from rq.job import Job  # type: ignore
        from rq.queue import Queue as _Q  # type: ignore

        job = Job.fetch(rq_job_id, connection=client)
        status = job.get_status(refresh=True)
        if status != "queued":
            return "not_queued"
        origin = job.origin or _QUEUE_DEFAULT
        if origin == dest:
            return "already"
        # Pull it out of its current lane, then push onto dest. RQ's
        # enqueue_job re-stamps job.origin and appends to dest's list.
        _Q(origin, connection=client).remove(job)
        _Q(dest, connection=client).enqueue_job(job)
        return "moved"
    except Exception:  # noqa: BLE001
        return "error"


def iter_jobs(client, failed_limit: int = 50) -> list[dict]:
    """Enumerate jobs across the priority lanes for the admin Jobs page.

    Returns plain dicts (queued → running → failed) with the fields the
    UI needs. Best-effort per job: a job whose hash vanished mid-read is
    skipped rather than failing the whole listing.
    """
    from rq.job import Job  # type: ignore
    from rq.queue import Queue as _Q  # type: ignore
    from rq.registry import (  # type: ignore
        FailedJobRegistry,
        StartedJobRegistry,
    )

    def _iso(dt):
        try:
            return dt.isoformat() if dt is not None else None
        except Exception:  # noqa: BLE001
            return None

    def _row(job, state: str, lane: str) -> dict | None:
        try:
            fn = (job.func_name or "").rsplit(".", 1)[-1]
            return {
                "id": job.id,
                "func": fn,
                "description": job.description,
                "lane": lane,
                "state": state,
                "enqueued_at": _iso(job.enqueued_at),
                "started_at": _iso(job.started_at),
            }
        except Exception:  # noqa: BLE001
            return None

    rows: list[dict] = []
    for lane in _LANES:
        try:
            for job in _Q(lane, connection=client).jobs:
                r = _row(job, "queued", lane)
                if r:
                    rows.append(r)
        except Exception:  # noqa: BLE001
            continue
    for lane in _LANES:
        try:
            ids = StartedJobRegistry(lane, connection=client).get_job_ids()
            for jid in ids:
                try:
                    r = _row(Job.fetch(jid, connection=client), "running", lane)
                    if r:
                        rows.append(r)
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            continue
    for lane in _LANES:
        try:
            ids = FailedJobRegistry(
                lane, connection=client
            ).get_job_ids()[-failed_limit:]
            for jid in ids:
                try:
                    r = _row(Job.fetch(jid, connection=client), "failed", lane)
                    if r:
                        rows.append(r)
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            continue
    return rows
