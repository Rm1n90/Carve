# Armin Mehri — mehri.armin@gmail.com
"""RQ queue + enqueue helpers (plan-09 task-09).

``enqueue_with_defaults`` wraps ``Queue.enqueue`` so every enqueue site
gets the same TTLs and a per-callable ``job_timeout``, instead of each
caller hand-rolling these (and disagreeing).

Per-callable timeouts (seconds):

    run_batch_auto_annotate     2 * 3600    (predict-batch — slow)
    run_auto_text_batch         2 * 3600    (SAM-text batch)
    extract_frames_for_video    30 * 60     (frames extraction)
    run_retrain_job             24 * 3600   (training is the long pole)

Unknown callables fall back to RQ's default timeout. Callers may also
pass an explicit ``job_timeout`` kwarg, which always wins.
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
    """
    kwargs.setdefault("result_ttl", _DEFAULT_RESULT_TTL)
    kwargs.setdefault("failure_ttl", _DEFAULT_FAILURE_TTL)

    if "job_timeout" not in kwargs:
        timeout = _JOB_TIMEOUTS.get(_callable_name(fn))
        if timeout is not None:
            kwargs["job_timeout"] = timeout

    return queue.enqueue(fn, *args, **kwargs)
