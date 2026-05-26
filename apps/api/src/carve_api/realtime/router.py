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
from carve_api.realtime.bus import get_bus
from carve_api.realtime.manager import Connection, get_manager
from carve_api.realtime.schemas import (
    PROTOCOL_VERSION,
    ClientPing,
    ClientPresenceCursor,
    ClientPresenceFocus,
    ErrorCode,
    ServerError,
    ServerHello,
    ServerPong,
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
    token = await issue_ticket(user.id, payload.task_id)
    return TicketResponse(ticket=token, expires_in=TICKET_TTL_SECONDS)


# --- WebSocket: /realtime/ws/{task_id} --------------------------------------


@router.websocket("/ws/{task_id}")
async def realtime_ws(
    websocket: WebSocket,
    task_id: uuid.UUID,
    ticket: str = Query(..., min_length=1, max_length=128),
) -> None:
    """WebSocket endpoint. Validates ticket, upgrades, runs the loop.

    Phase 1 only handles ``ping``. Unknown / malformed inbound messages
    get a structured ``error`` envelope. Disconnects propagate as a
    normal ``WebSocketDisconnect``; cancellation cleans up the sender
    task and unregisters the connection.
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
    bus = get_bus()
    session_id = uuid.uuid4()
    conn = Connection(
        session_id=session_id,
        user_id=payload.user_id,
        task_id=task_id,
        ws=websocket,
    )
    manager.register(conn)

    sender_task = asyncio.create_task(manager.run_sender(conn))
    try:
        # ``hello`` carries the session id, current event seq for
        # gap-detection, and a server timestamp clients can use to skew
        # their own clock when interpreting ``ts`` fields.
        last_event_seq = await bus.current_seq(task_id)
        hello = ServerHello(
            session_id=session_id,
            user_id=payload.user_id,
            task_id=task_id,
            server_time=int(time.time() * 1000),
            last_event_seq=last_event_seq,
            presence=[],  # Phase 5 fills this in.
        )
        manager.enqueue(conn, hello.model_dump(mode="json"))

        # --- receive loop ---------------------------------------------
        # Phase 1 only recognises ``ping``. All other types reply with
        # ``error`` (structured) and keep the connection alive — that
        # matches forward-compat semantics: older servers shouldn't kill
        # newer clients that send a type the server hasn't learned yet.
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
            # Phase 1 doesn't handle presence types yet — but they
            # validate fine, so reply with a deliberate "not yet" error.
            manager.enqueue(
                conn,
                ServerError(
                    code=ErrorCode.UNKNOWN_TYPE,
                    message=f"type not handled in phase 1: {type(envelope).__name__}",
                ).model_dump(mode="json"),
            )
    finally:
        manager.unregister(conn)
        await manager.request_close(conn)
        # Give the sender a moment to drain + close cleanly.
        try:
            await asyncio.wait_for(sender_task, timeout=1.0)
        except (TimeoutError, asyncio.CancelledError):
            sender_task.cancel()


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
