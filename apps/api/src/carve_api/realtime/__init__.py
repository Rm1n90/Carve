# Armin Mehri — mehri.armin@gmail.com
"""Realtime collaboration module.

Phase 1 of the realtime feature (live data-sync + presence). This first
phase ships the **foundation only**: an async Redis pub/sub bus, a
one-time ticket-based WebSocket auth, an in-process connection manager
that fans out incoming messages, and a WebSocket endpoint that handles
``hello`` / ``ping`` / ``pong`` so the wire shape and reconnect
behaviour can be verified end-to-end before Phase 2 wires in annotation
mutations.

Files:

  * :mod:`bus`      — async Redis publish/subscribe + per-task monotonic
                      sequence + bounded replay buffer (5 min, 200 evt).
  * :mod:`schemas`  — Pydantic v2 envelopes for inbound and outbound
                      WebSocket messages.
  * :mod:`tickets`  — short-lived (30s), one-shot Redis tickets that
                      authorise a single WebSocket upgrade.
  * :mod:`manager`  — per-task connection set with per-conn send queue
                      (cap 256 → close 1011) for backpressure.
  * :mod:`router`   — ``POST /realtime/ticket`` and
                      ``WS /realtime/ws/{task_id}``.

The bus, manager, schemas and tickets carry no FastAPI imports so they
can be unit-tested without an app. The router is the only piece that
depends on FastAPI / Starlette.
"""

from carve_api.realtime.bus import EventEnvelope, get_bus
from carve_api.realtime.manager import ConnectionManager, get_manager
from carve_api.realtime.tickets import (
    TICKET_TTL_SECONDS,
    consume_ticket,
    issue_ticket,
)

__all__ = [
    "ConnectionManager",
    "EventEnvelope",
    "TICKET_TTL_SECONDS",
    "consume_ticket",
    "get_bus",
    "get_manager",
    "issue_ticket",
]
