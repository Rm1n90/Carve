# Armin Mehri — mehri.armin@gmail.com
"""Pydantic envelopes for the realtime WebSocket protocol.

The protocol is versioned at the envelope level (``v=1``). Adding new
``type`` values is backwards compatible — older clients that don't
recognise a type drop it silently. Removing or repurposing a type is a
breaking change and must bump ``v``.

Phase 1 only exercises three outbound types (``hello`` / ``pong`` /
``error``) and one inbound type (``ping``). The presence + ops
discriminants are declared here so phases 2 / 5 can plug in payload
handlers without re-shaping the schema module.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PROTOCOL_VERSION = 1


class ClientFocusTarget(BaseModel):
    """Phase 5 — what a user is currently editing (soft indicator)."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["annotation"]
    id: uuid.UUID


# --- Inbound (client → server) ----------------------------------------------


class _InboundBase(BaseModel):
    """``extra="forbid"`` keeps schema drift visible — the dispatcher
    catches the ValidationError and replies with an ``error`` envelope
    so the WS itself stays open."""

    model_config = ConfigDict(extra="forbid")
    v: Literal[1] = PROTOCOL_VERSION


class ClientPing(_InboundBase):
    type: Literal["ping"]


class ClientPresenceCursor(_InboundBase):
    """Phase 5 — declared now so the type registry is stable."""

    type: Literal["presence:cursor"]
    asset_id: uuid.UUID
    frame_id: uuid.UUID | None = None
    # Image-pixel coords, not screen pixels. Float for sub-pixel
    # smoothing when interpolating between received cursors.
    x: float
    y: float


class ClientPresenceFocus(_InboundBase):
    type: Literal["presence:focus"]
    target: ClientFocusTarget | None = None


ClientMessage = Annotated[
    ClientPing | ClientPresenceCursor | ClientPresenceFocus,
    Field(discriminator="type"),
]


# --- Outbound (server → client) ---------------------------------------------


class _OutboundBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1] = PROTOCOL_VERSION


class PresenceUser(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID
    session_id: uuid.UUID
    name: str
    color: str  # ``#rrggbb``


class ServerHello(_OutboundBase):
    type: Literal["hello"] = "hello"
    session_id: uuid.UUID
    user_id: uuid.UUID
    task_id: uuid.UUID
    server_time: int  # epoch ms
    last_event_seq: int
    # Empty in Phase 1 — populated by the connection manager once
    # Phase 5 wires presence in.
    presence: list[PresenceUser] = Field(default_factory=list)


class ServerPong(_OutboundBase):
    type: Literal["pong"] = "pong"
    server_time: int


class ServerError(_OutboundBase):
    type: Literal["error"] = "error"
    code: str
    message: str


class ServerOpsUpsert(_OutboundBase):
    """Phase 2 — declared now so phase 2 plugs in without a schema break."""

    type: Literal["ops:upsert"] = "ops:upsert"
    seq: int
    ts: int
    annotation: dict[str, Any]
    actor_id: uuid.UUID
    origin_session: uuid.UUID | None = None


class ServerOpsDelete(_OutboundBase):
    type: Literal["ops:delete"] = "ops:delete"
    seq: int
    ts: int
    annotation_id: uuid.UUID
    actor_id: uuid.UUID
    origin_session: uuid.UUID | None = None


class ServerOpsBatch(_OutboundBase):
    type: Literal["ops:batch"] = "ops:batch"
    seq: int
    ts: int
    ops: list[dict[str, Any]]
    actor_id: uuid.UUID
    origin_session: uuid.UUID | None = None


class ServerPresenceJoin(_OutboundBase):
    type: Literal["presence:join"] = "presence:join"
    user: PresenceUser


class ServerPresenceLeave(_OutboundBase):
    type: Literal["presence:leave"] = "presence:leave"
    session_id: uuid.UUID
    user_id: uuid.UUID


class ServerPresenceCursor(_OutboundBase):
    type: Literal["presence:cursor"] = "presence:cursor"
    session_id: uuid.UUID
    user_id: uuid.UUID
    asset_id: uuid.UUID
    frame_id: uuid.UUID | None = None
    x: float
    y: float


class ServerPresenceFocus(_OutboundBase):
    type: Literal["presence:focus"] = "presence:focus"
    session_id: uuid.UUID
    user_id: uuid.UUID
    target: ClientFocusTarget | None = None


class ErrorCode:
    """Stable error codes the frontend may pattern-match on."""

    INVALID_TICKET = "invalid_ticket"
    TICKET_TASK_MISMATCH = "ticket_task_mismatch"
    UNKNOWN_TYPE = "unknown_type"
    INVALID_PAYLOAD = "invalid_payload"
    BACKPRESSURE_OVERFLOW = "backpressure_overflow"
    INTERNAL = "internal"


__all__ = [
    "PROTOCOL_VERSION",
    "ClientFocusTarget",
    "ClientMessage",
    "ClientPing",
    "ClientPresenceCursor",
    "ClientPresenceFocus",
    "ErrorCode",
    "PresenceUser",
    "ServerError",
    "ServerHello",
    "ServerOpsBatch",
    "ServerOpsDelete",
    "ServerOpsUpsert",
    "ServerPong",
    "ServerPresenceCursor",
    "ServerPresenceFocus",
    "ServerPresenceJoin",
    "ServerPresenceLeave",
]
