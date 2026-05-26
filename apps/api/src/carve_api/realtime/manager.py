# Armin Mehri — mehri.armin@gmail.com
"""In-process WebSocket connection manager.

Responsibilities, by scope:

  * Track open connections, indexed by ``task_id``.
  * Per-connection bounded send queue. Overflow → close 1011 instead
    of letting a slow client block the broadcast loop.
  * Expose a ``broadcast(task_id, …)`` API the WS endpoint uses to
    fan out **local** events (cross-process fan-out is the bus's job in
    Phase 2 onwards).

What this module does *not* do:

  * No Redis. The bus subscribes per-task and feeds messages back into
    ``broadcast`` from the router; the manager stays pure so it's easy
    to unit test.
  * No FastAPI. The ``ws`` field is typed against ``WebSocketLike`` so
    tests can pass a small in-memory double.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Per-connection outbound queue cap. Hits when a client is slow and we
# keep producing. Picked to absorb a small burst (~ a couple of seconds
# of cursor events at 20 Hz) without unbounded growth.
SEND_QUEUE_MAX = 256


class WebSocketLike(Protocol):
    """The narrow slice of FastAPI's WebSocket we depend on. Tests pass
    a small double; production passes ``starlette.websockets.WebSocket``."""

    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int = ..., reason: str | None = ...) -> None: ...


@dataclass(slots=True, eq=False)
class Connection:
    """One open WebSocket session.

    ``session_id`` is what the client sees in its ``hello`` envelope and
    what mutating REST calls echo back via ``X-Origin-Session`` so we
    can suppress the originator's own broadcast.

    Phase 5 — presence fields. ``user_name`` + ``color`` are baked in
    at construction time (from the ticket payload + deterministic
    palette hash) so broadcasts don't need a DB lookup per event. The
    cursor + focus fields are live state mutated by inbound presence
    frames and read by ``snapshot()`` for late-joiners.
    """

    session_id: uuid.UUID
    user_id: uuid.UUID
    task_id: uuid.UUID
    ws: WebSocketLike
    send_queue: asyncio.Queue[str] = field(
        default_factory=lambda: asyncio.Queue(maxsize=SEND_QUEUE_MAX)
    )
    # Set when the sender task observes a queue overflow. The router's
    # receive loop checks this so it can break out instead of trying to
    # read from a doomed socket.
    overflowed: bool = False

    # ---- Phase 5: presence ---------------------------------------------

    user_name: str = ""
    color: str = "#888888"  # neutral grey — overwritten at register time
    # Last cursor reported by this client. ``None`` until the first
    # presence:cursor frame arrives. Image-pixel coords (floats); the
    # frontend coalesces zoom-space to image-space before sending.
    cursor_asset_id: uuid.UUID | None = None
    cursor_frame_id: uuid.UUID | None = None
    cursor_x: float = 0.0
    cursor_y: float = 0.0
    # Used by :class:`carve_api.realtime.presence.PresenceTracker` to
    # throttle outbound cursor broadcasts. Epoch ms.
    last_cursor_broadcast_ms: int = 0
    # Annotation the user is currently editing / interacting with, if
    # any. Stored as the literal dict the wire frame carries (kind,
    # id) so we can rebroadcast it without re-validating.
    focus_target: dict | None = None


class ConnectionManager:
    """In-process registry. One per worker process; cross-process fan-out
    is the bus's job."""

    def __init__(self) -> None:
        self._by_task: dict[uuid.UUID, set[Connection]] = defaultdict(set)
        # Hold ``Connection.session_id`` for quick lookup in tests +
        # presence cleanup (Phase 5).
        self._by_session: dict[uuid.UUID, Connection] = {}

    # --- registration --------------------------------------------------

    def register(self, conn: Connection) -> None:
        self._by_task[conn.task_id].add(conn)
        self._by_session[conn.session_id] = conn

    def unregister(self, conn: Connection) -> None:
        peers = self._by_task.get(conn.task_id)
        if peers is not None:
            peers.discard(conn)
            if not peers:
                self._by_task.pop(conn.task_id, None)
        self._by_session.pop(conn.session_id, None)

    # --- introspection (used by tests + Phase 5 presence) -------------

    def connections_for(self, task_id: uuid.UUID) -> list[Connection]:
        return list(self._by_task.get(task_id, set()))

    def session_count(self, task_id: uuid.UUID) -> int:
        return len(self._by_task.get(task_id, set()))

    # --- broadcast -----------------------------------------------------

    def enqueue(self, conn: Connection, message: dict[str, Any]) -> bool:
        """Enqueue one message for a specific connection.

        Returns ``False`` if the queue is full — the sender task will
        observe this and tear the connection down. We don't drop the
        message silently because doing so would create an undetectable
        gap; the client will reconnect and replay instead.
        """
        if conn.overflowed:
            return False
        try:
            conn.send_queue.put_nowait(_serialize(message))
            return True
        except asyncio.QueueFull:
            conn.overflowed = True
            logger.warning(
                "realtime: send queue overflow for session=%s task=%s",
                conn.session_id,
                conn.task_id,
            )
            return False

    def broadcast(
        self,
        task_id: uuid.UUID,
        message: dict[str, Any],
        *,
        exclude_session: uuid.UUID | None = None,
    ) -> int:
        """Enqueue ``message`` on every open connection for ``task_id``.

        Returns the number of queues the message was accepted into.
        ``exclude_session`` suppresses the originator (echo-suppression
        at the connection level — the REST handler also tags the
        broadcast with ``origin_session`` so other tabs of the same
        user still receive it).
        """
        accepted = 0
        for conn in self._by_task.get(task_id, set()):
            if exclude_session is not None and conn.session_id == exclude_session:
                continue
            if self.enqueue(conn, message):
                accepted += 1
        return accepted

    # --- sender loop ---------------------------------------------------

    async def run_sender(self, conn: Connection) -> None:
        """Drain ``conn.send_queue`` to ``conn.ws.send_text`` until the
        socket errors or the queue is closed (signalled by the close
        sentinel).

        This is the **only** place we call ``send_text``. Centralising
        the write keeps backpressure on a single queue and lets us
        close cleanly on overflow.
        """
        try:
            while True:
                if conn.overflowed:
                    await conn.ws.close(code=1011, reason="backpressure_overflow")
                    return
                payload = await conn.send_queue.get()
                if payload == _SENTINEL_CLOSE:
                    return
                try:
                    await conn.ws.send_text(payload)
                except Exception as exc:  # noqa: BLE001 — log + bail
                    logger.info(
                        "realtime: send_text failed session=%s err=%r",
                        conn.session_id,
                        exc,
                    )
                    return
        except asyncio.CancelledError:
            raise

    async def request_close(self, conn: Connection) -> None:
        """Politely stop the sender. Used by the router on shutdown."""
        try:
            conn.send_queue.put_nowait(_SENTINEL_CLOSE)
        except asyncio.QueueFull:
            # Overflowed → sender will tear down on its own next tick.
            conn.overflowed = True


# --- module helpers ---------------------------------------------------------

_SENTINEL_CLOSE = "__close__"


def _serialize(message: dict[str, Any]) -> str:
    """JSON encoding shared by enqueue + tests."""
    return json.dumps(message, separators=(",", ":"))


_manager: ConnectionManager | None = None


def get_manager() -> ConnectionManager:
    """Process-wide singleton manager. Workers run as separate processes,
    so one per process is correct."""
    global _manager
    if _manager is None:
        _manager = ConnectionManager()
    return _manager


def reset_manager_for_test() -> ConnectionManager:
    """Wipe the singleton. Tests only — production workers should never
    rebuild the manager mid-flight."""
    global _manager
    _manager = ConnectionManager()
    return _manager
