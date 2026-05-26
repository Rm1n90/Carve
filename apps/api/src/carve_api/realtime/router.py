# Armin Mehri — mehri.armin@gmail.com
"""FastAPI router for the realtime collaboration endpoints.

Two surfaces:

  * ``POST /realtime/ticket`` — authenticated REST endpoint. Verifies
    task membership via ``require_visible_task`` (same gate the
    annotations router uses) and mints a one-time ticket.
  * ``WS /realtime/ws/{task_id}`` — consumes the ticket via query
    string, upgrades to a WebSocket, and runs the receive loop. Phase
    1 only dispatches ``ping`` / ``pong`` + handles unknown types with
    a structured ``error`` reply. Phases 2 / 5 plug into the same
    receive loop without touching the auth path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.orm import Session

from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.projects.service import require_visible_task
from carve_api.realtime.bus import EventEnvelope, get_bus
from carve_api.realtime.manager import Connection, get_manager
from carve_api.realtime.presence import color_for_user, get_tracker
from carve_api.realtime.schemas import (
    PROTOCOL_VERSION,
    ClientPing,
    ClientPresenceCursor,
    ClientPresenceFocus,
    ErrorCode,
    ServerError,
    ServerHello,
    ServerPong,
    ServerResync,
)
from carve_api.realtime.tickets import (
    TICKET_TTL_SECONDS,
    consume_ticket,
    issue_ticket,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/realtime", tags=["realtime"])


# --- REST: ticket issue ------------------------------------------------------


class TicketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID


class TicketResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket: str
    expires_in: int


@router.post("/ticket", response_model=TicketResponse)
async def post_ticket(
    payload: TicketRequest = Body(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TicketResponse:
    """Issue a one-time WS ticket for ``(user, task_id)``.

    Re-uses ``require_visible_task`` so the membership rules stay
    consistent with the existing REST surface — a user who couldn't
    ``GET /tasks/{id}/annotations`` cannot mint a ticket either.
    """
    # ``require_visible_task`` raises HTTPException on 403/404 which is
    # exactly what we want to surface to the client.
    require_visible_task(db, user, payload.task_id)
    # Phase 5 — derive a presence display name from the email's local
    # part. We capture it at ticket-issue time so the WS handler doesn't
    # need its own DB session to look the user up. Worst case (user
    # changes their email between ticket issue + WS upgrade — 30 s
    # window) the presence label is briefly stale; acceptable.
    user_name = _display_name_for_email(user.email)
    token = await issue_ticket(
        user.id, payload.task_id, user_name=user_name,
    )
    return TicketResponse(ticket=token, expires_in=TICKET_TTL_SECONDS)


def _display_name_for_email(email: str) -> str:
    """Trim ``user@host.tld`` down to a short display label.

    Phase 5 uses the local-part (everything before ``@``), capped at
    32 chars so very long emails don't break the presence chips.
    Empty or malformed emails fall back to a neutral "User" label.
    """
    if not email or "@" not in email:
        return "User"
    local = email.split("@", 1)[0].strip()
    if not local:
        return "User"
    return local[:32]


# --- WebSocket: /realtime/ws/{task_id} --------------------------------------


@router.websocket("/ws/{task_id}")
async def realtime_ws(
    websocket: WebSocket,
    task_id: uuid.UUID,
    ticket: str = Query(..., min_length=1, max_length=128),
    last_event_seq: int = Query(
        default=0,
        ge=0,
        description=(
            "Highest seq the client already applied. 0 means cold start. "
            "On reconnect the server replays buffered events newer than "
            "this; if the buffer's oldest is younger, the server sends a "
            "``resync`` envelope so the client refetches from REST."
        ),
    ),
) -> None:
    """WebSocket endpoint. Validates ticket, upgrades, runs three
    cooperating async tasks until the socket closes:

      * the **receive loop** (main coroutine) — drains client frames,
        replies to ``ping`` with ``pong``;
      * a **sender task** — drains the manager's outbound queue to
        ``ws.send_text`` (centralises backpressure);
      * a **subscriber task** (Phase 2) — replays any events newer
        than ``last_event_seq`` from the bus and then listens for
        live events to forward to this connection.

    Unknown / malformed inbound messages get a structured ``error``
    envelope. Disconnects propagate as a normal ``WebSocketDisconnect``;
    cancellation cleans up the sender + subscriber tasks and
    unregisters the connection.
    """
    payload = await consume_ticket(ticket)
    if payload is None:
        # Close *before* accept so the browser sees a handshake failure
        # rather than an unexpected 1006 mid-stream.
        await websocket.close(code=4401, reason=ErrorCode.INVALID_TICKET)
        return
    if payload.task_id != task_id:
        await websocket.close(code=4401, reason=ErrorCode.TICKET_TASK_MISMATCH)
        return

    await websocket.accept()

    manager = get_manager()
    tracker = get_tracker()
    bus = get_bus()
    session_id = uuid.uuid4()
    conn = Connection(
        session_id=session_id,
        user_id=payload.user_id,
        task_id=task_id,
        ws=websocket,
        # Phase 5 — presence metadata baked in at construct time so
        # downstream broadcasts don't need a DB lookup per event.
        user_name=payload.user_name or "User",
        color=color_for_user(payload.user_id),
    )
    manager.register(conn)

    sender_task = asyncio.create_task(manager.run_sender(conn))
    subscriber_task: asyncio.Task[None] | None = None
    pubsub = None
    try:
        # Phase 2 — subscribe to the bus BEFORE reading current_seq /
        # sending hello. Doing it here (rather than inside the
        # subscriber task) guarantees the SUBSCRIBE has landed at
        # Redis before any value we read or send. So hello's
        # ``last_event_seq`` is a watermark: anything published with
        # seq > that value is guaranteed to be delivered live, never
        # missed-and-only-replayable.
        pubsub = await bus.open_subscription(task_id)

        # ``hello`` carries the session id, current event seq for
        # gap-detection, a server timestamp clients can use to skew
        # their own clock when interpreting ``ts`` fields, and (Phase
        # 5) the snapshot of every other user currently connected to
        # this task — so a fresh join doesn't have to wait for the
        # next presence:join from each peer to render avatars.
        current_seq = await bus.current_seq(task_id)
        presence_snapshot = tracker.snapshot(
            task_id, exclude_session=session_id,
        )
        hello = ServerHello(
            session_id=session_id,
            user_id=payload.user_id,
            task_id=task_id,
            server_time=int(time.time() * 1000),
            last_event_seq=current_seq,
            presence=presence_snapshot,
        )
        manager.enqueue(conn, hello.model_dump(mode="json"))
        # Phase 5 — fan out a join to peers AFTER the new client has
        # received its own hello. The order matters: existing peers
        # see "X joined" only once X exists in the manager.
        tracker.broadcast_join(conn)

        # Subscriber task receives the already-subscribed pubsub so
        # it never has to do its own SUBSCRIBE call.
        subscriber_task = asyncio.create_task(
            _ws_subscriber(conn, task_id, last_event_seq, pubsub)
        )

        # --- receive loop ---------------------------------------------
        # Phase 1+2 honour ``ping``. Presence types (Phase 5) validate
        # but reply with ``unknown_type`` so the wire stays
        # forward-compatible — older servers don't kill newer clients
        # that send a type the server hasn't learned yet.
        while True:
            if conn.overflowed:
                # The sender already started closing; just leave.
                break
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break

            envelope = _parse_inbound(raw, conn)
            if envelope is None:
                continue
            if isinstance(envelope, ClientPing):
                manager.enqueue(
                    conn,
                    ServerPong(server_time=int(time.time() * 1000)).model_dump(
                        mode="json"
                    ),
                )
                continue
            if isinstance(envelope, ClientPresenceCursor):
                # Tracker does the throttle + broadcast — the result is
                # only useful for telemetry / tests.
                tracker.update_cursor(
                    conn,
                    asset_id=envelope.asset_id,
                    frame_id=envelope.frame_id,
                    x=envelope.x,
                    y=envelope.y,
                )
                continue
            if isinstance(envelope, ClientPresenceFocus):
                tracker.update_focus(
                    conn,
                    envelope.target.model_dump(mode="json") if envelope.target else None,
                )
                continue
            # Unknown / unhandled type — reply with a structured error.
            manager.enqueue(
                conn,
                ServerError(
                    code=ErrorCode.UNKNOWN_TYPE,
                    message=f"type not handled yet: {type(envelope).__name__}",
                ).model_dump(mode="json"),
            )
    finally:
        # Phase 5 — broadcast leave BEFORE unregister so peers still
        # in the task's connection set actually receive the envelope.
        # Unregistering first would skip them because broadcast walks
        # the live set.
        try:
            tracker.broadcast_leave(conn)
        except Exception:  # noqa: BLE001 — never block teardown
            logger.exception("realtime: broadcast_leave failed")
        manager.unregister(conn)
        await manager.request_close(conn)
        # Tear down the subscriber first so it can't enqueue a stale
        # message after we've unregistered — that would just leak a
        # queue entry, but it's noise.
        if subscriber_task is not None:
            subscriber_task.cancel()
            try:
                await asyncio.wait_for(subscriber_task, timeout=1.0)
            except (TimeoutError, asyncio.CancelledError):
                pass
        # Now close the pub/sub channel. Subscriber owned the read
        # loop; we own the resource lifecycle.
        if pubsub is not None:
            await bus.close_subscription(pubsub)
        # Give the sender a moment to drain + close cleanly.
        try:
            await asyncio.wait_for(sender_task, timeout=1.0)
        except (TimeoutError, asyncio.CancelledError):
            sender_task.cancel()


# --- Phase 2 subscriber loop -------------------------------------------------


async def _ws_subscriber(
    conn: Connection,
    task_id: uuid.UUID,
    replay_from_seq: int,
    pubsub,
) -> None:
    """Replay any missed events, then forward live ones to ``conn``.

    The caller (``realtime_ws``) owns the pub/sub lifecycle and passes
    an already-subscribed object in via ``pubsub``. That way the
    SUBSCRIBE has landed at Redis before any publish that can race
    with this loop.

    Order of operations:

      1. If ``replay_from_seq > 0``, ask the bus for everything newer
         from the replay buffer. ``gap=True`` means the client's
         last_event_seq fell out of the replay window, so we send a
         ``resync`` envelope and skip the partial replay (the client
         will throw away its local state and refetch via REST).
      2. Forward every live envelope to the connection's send queue.

    Echo-suppression: the publisher tags each envelope with the
    originating tab's ``origin_session``. If that matches *this*
    connection's session_id we skip the enqueue — that tab already
    applied the mutation optimistically and would otherwise see it
    flicker.

    Cancellation: the parent ``realtime_ws`` cancels this task in its
    finally block. ``iter_envelopes`` propagates the CancelledError
    cleanly; the parent closes the pubsub afterwards.
    """
    bus = get_bus()
    manager = get_manager()

    if replay_from_seq > 0:
        newer, gap = await bus.replay_since(task_id, replay_from_seq)
        if gap:
            manager.enqueue(
                conn,
                ServerResync(reason="gap_replay").model_dump(mode="json"),
            )
        else:
            for env in newer:
                if _is_echo(conn, env):
                    continue
                manager.enqueue(conn, _flatten(env))

    async for env in bus.iter_envelopes(pubsub):
        if _is_echo(conn, env):
            continue
        manager.enqueue(conn, _flatten(env))


def _is_echo(conn: Connection, env: EventEnvelope) -> bool:
    """True when the envelope originated from this connection's tab.

    Mutating REST calls echo the caller's ``X-Origin-Session`` header
    onto the broadcast (see :mod:`carve_api.realtime.events`); the
    originating WS skips its own echo so optimistic local state
    doesn't flicker on the round-trip.
    """
    origin = env.payload.get("origin_session")
    return isinstance(origin, str) and origin == str(conn.session_id)


def _flatten(env: EventEnvelope) -> dict[str, Any]:
    """Merge the bus-stamped ``seq``/``ts`` into the payload so the
    outbound frame matches the schemas advertised in
    :mod:`carve_api.realtime.schemas` (``ServerOpsUpsert`` &c.).

    Done at send time rather than publish time so the seq is allocated
    once by the bus and consumed by every subscriber identically.
    """
    return {**env.payload, "seq": env.seq, "ts": env.ts}


def _parse_inbound(raw: str, conn: Connection):
    """Parse one inbound frame.

    Returns a typed message on success, or ``None`` after enqueueing a
    structured error on the connection. Never raises — the receive loop
    relies on this to stay running across malformed messages.
    """
    manager = get_manager()
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        manager.enqueue(
            conn,
            ServerError(
                code=ErrorCode.INVALID_PAYLOAD,
                message="not valid json",
            ).model_dump(mode="json"),
        )
        return None
    if not isinstance(obj, dict) or obj.get("v") != PROTOCOL_VERSION:
        manager.enqueue(
            conn,
            ServerError(
                code=ErrorCode.INVALID_PAYLOAD,
                message=f"expected v={PROTOCOL_VERSION}",
            ).model_dump(mode="json"),
        )
        return None
    t = obj.get("type")
    try:
        if t == "ping":
            return ClientPing.model_validate(obj)
        if t == "presence:cursor":
            return ClientPresenceCursor.model_validate(obj)
        if t == "presence:focus":
            return ClientPresenceFocus.model_validate(obj)
    except ValidationError as exc:
        first = exc.errors(include_url=False)
        message = first[0]["msg"] if first else "validation failed"
        manager.enqueue(
            conn,
            ServerError(
                code=ErrorCode.INVALID_PAYLOAD,
                message=message,
            ).model_dump(mode="json"),
        )
        return None
    manager.enqueue(
        conn,
        ServerError(
            code=ErrorCode.UNKNOWN_TYPE,
            message=f"unknown type: {t!r}",
        ).model_dump(mode="json"),
    )
    return None


__all__ = ["router"]
