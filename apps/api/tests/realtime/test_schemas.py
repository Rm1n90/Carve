# Armin Mehri — mehri.armin@gmail.com
"""Pure pydantic validation for the realtime wire schemas.

No Redis, no app. These tests catch envelope drift (missing version,
extra fields, wrong discriminator) before phases 2+ start producing
messages.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from carve_api.realtime.schemas import (
    PROTOCOL_VERSION,
    ClientPing,
    ClientPresenceCursor,
    ErrorCode,
    ServerError,
    ServerHello,
    ServerOpsBatch,
    ServerOpsDelete,
    ServerOpsUpsert,
    ServerPong,
    ServerPresenceCursor,
    ServerPresenceFocus,
    ServerPresenceJoin,
    ServerPresenceLeave,
)


def test_protocol_version_constant_is_one() -> None:
    # Bump must be a deliberate breaking change — guard against an
    # accidental edit.
    assert PROTOCOL_VERSION == 1


def test_client_ping_requires_v_one() -> None:
    with pytest.raises(ValidationError):
        ClientPing.model_validate({"v": 2, "type": "ping"})


def test_client_ping_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ClientPing.model_validate({"v": 1, "type": "ping", "junk": 1})


def test_client_presence_cursor_round_trips() -> None:
    raw = {
        "v": 1,
        "type": "presence:cursor",
        "asset_id": str(uuid.uuid4()),
        "x": 12.5,
        "y": 24.0,
    }
    msg = ClientPresenceCursor.model_validate(raw)
    assert msg.frame_id is None
    assert msg.x == 12.5


def test_server_hello_serializes_with_default_presence() -> None:
    hello = ServerHello(
        session_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        task_id=uuid.uuid4(),
        server_time=1_700_000_000_000,
        last_event_seq=0,
    )
    body = hello.model_dump(mode="json")
    assert body["type"] == "hello"
    assert body["v"] == 1
    assert body["presence"] == []


def test_server_pong_carries_server_time() -> None:
    pong = ServerPong(server_time=1)
    body = pong.model_dump(mode="json")
    assert body == {"v": 1, "type": "pong", "server_time": 1}


def test_server_error_uses_stable_codes() -> None:
    # Frontend pattern-matches on code strings; lock them down.
    assert ErrorCode.INVALID_TICKET == "invalid_ticket"
    assert ErrorCode.TICKET_TASK_MISMATCH == "ticket_task_mismatch"
    assert ErrorCode.UNKNOWN_TYPE == "unknown_type"
    assert ErrorCode.INVALID_PAYLOAD == "invalid_payload"
    err = ServerError(code=ErrorCode.INVALID_TICKET, message="x")
    body = err.model_dump(mode="json")
    assert body["type"] == "error" and body["code"] == "invalid_ticket"


@pytest.mark.parametrize(
    "model, type_str",
    [
        (ServerOpsUpsert, "ops:upsert"),
        (ServerOpsDelete, "ops:delete"),
        (ServerOpsBatch, "ops:batch"),
        (ServerPresenceJoin, "presence:join"),
        (ServerPresenceLeave, "presence:leave"),
        (ServerPresenceCursor, "presence:cursor"),
        (ServerPresenceFocus, "presence:focus"),
    ],
)
def test_outbound_type_discriminators_are_locked(model, type_str: str) -> None:
    # The frontend dispatches on ``type``; freezing the literal here
    # prevents an accidental rename in a future PR.
    field = model.model_fields["type"]
    # The literal is the default value of the type-tagged field.
    assert field.default == type_str
