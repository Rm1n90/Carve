# Armin Mehri — mehri.armin@gmail.com
"""Background thread that keeps provider batches moving.

A batch finishes on the provider's clock — minutes to 24 hours after it
was submitted, usually with nobody watching. This thread wakes every few
seconds, asks the job table which batches are due a check, and queues a
poll for each; the RQ worker does the actual polling and ingestion.

The same tick is the runs' supervisor: a run that should be working and
has nothing behind it in RQ (the machine lost power, the worker was
killed, the run stepped back to wait for the provider) is queued again
and resumes from what it last committed.

It runs inside the API process rather than as an RQ scheduler so the
schedule is derived from Postgres on every tick: nothing is lost if
Redis is flushed or the worker restarts, and no extra container or
worker flag is needed.
"""

from __future__ import annotations

import logging
import threading

from redis import Redis

from carve_api.config import get_settings
from carve_api.db import get_session_factory

log = logging.getLogger(__name__)

_TICK_SECONDS = 10
_LOCK_KEY = "logo_ai:poller:lock"

_started = False
_start_lock = threading.Lock()


def _tick() -> None:
    from carve_api.logo_ai.jobs import (
        clear_dead_rq_jobs,
        enqueue_due_polls,
        enqueue_stalled_runs,
    )

    s = get_settings()
    conn = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=2)
    # One API process does the scheduling per tick, however many run.
    if not conn.set(_LOCK_KEY, "1", nx=True, ex=_TICK_SECONDS - 1):
        return
    clear_dead_rq_jobs(conn)
    with get_session_factory()() as session:
        try:
            enqueue_due_polls(session, connection=conn)
        finally:
            # Independent of the polls: one failing must not starve the other.
            session.rollback()
            enqueue_stalled_runs(session, connection=conn)


def _loop(stop: threading.Event) -> None:
    while not stop.wait(_TICK_SECONDS):
        try:
            _tick()
        except Exception:  # noqa: BLE001 — a blip must not kill the thread
            log.warning("logo_ai.poller.tick_failed", exc_info=True)


def start_poller() -> None:
    """Start the thread once per process. No-op when no provider is
    configured: without a key there can be no batch to poll."""
    global _started
    s = get_settings()
    if not (s.anthropic_api_key or s.openai_api_key):
        return
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(
        target=_loop, args=(threading.Event(),), name="logo-ai-poller", daemon=True
    ).start()
