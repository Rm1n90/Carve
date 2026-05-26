# Armin Mehri — mehri.armin@gmail.com
"""Pure-logic tests for the in-process connection manager.

No FastAPI, no Redis. We pass a fake WS double into ``Connection`` so
the manager can be exercised independently of network IO.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field

from carve_api.realtime.manager import (
    SEND_QUEUE_MAX,
    Connection,
    ConnectionManager,
)


@dataclass
class FakeWS:
    """Minimal stand-in for ``starlette.websockets.WebSocket``."""

    sent: list[str] = field(default_factory=list)
    closed_with: tuple[int, str | None] | None = None

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed_with = (code, reason)


def _new_conn(task_id: uuid.UUID | None = None) -> Connection:
    return Connection(
        session_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        task_id=task_id or uuid.uuid4(),
        ws=FakeWS(),
    )


def test_register_and_unregister_round_trip() -> None:
    mgr = ConnectionManager()
    conn = _new_conn()
    mgr.register(conn)
    assert mgr.session_count(conn.task_id) == 1
    assert mgr.connections_for(conn.task_id) == [conn]
    mgr.unregister(conn)
    assert mgr.session_count(conn.task_id) == 0


def test_broadcast_reaches_all_connections_for_task() -> None:
    mgr = ConnectionManager()
    task = uuid.uuid4()
    a, b = _new_conn(task), _new_conn(task)
    other = _new_conn()  # different task — must not receive
    for c in (a, b, other):
        mgr.register(c)

    delivered = mgr.broadcast(task, {"v": 1, "type": "pong", "server_time": 7})
    assert delivered == 2
    assert a.send_queue.qsize() == 1
    assert b.send_queue.qsize() == 1
    assert other.send_queue.qsize() == 0


def test_broadcast_excludes_origin_session() -> None:
    mgr = ConnectionManager()
    task = uuid.uuid4()
    a, b = _new_conn(task), _new_conn(task)
    for c in (a, b):
        mgr.register(c)
    delivered = mgr.broadcast(
        task,
        {"v": 1, "type": "pong", "server_time": 1},
        exclude_session=a.session_id,
    )
    assert delivered == 1
    assert a.send_queue.qsize() == 0
    assert b.send_queue.qsize() == 1


def test_enqueue_overflow_marks_connection_and_refuses_further() -> None:
    mgr = ConnectionManager()
    conn = _new_conn()
    mgr.register(conn)
    # Fill the queue to capacity using the documented constant so this
    # test breaks loudly if the cap shifts.
    for i in range(SEND_QUEUE_MAX):
        assert mgr.enqueue(conn, {"v": 1, "type": "pong", "server_time": i}) is True
    # Next put would block; ``enqueue`` should detect that, flip the
    # flag, and refuse without raising.
    assert mgr.enqueue(conn, {"v": 1, "type": "pong", "server_time": -1}) is False
    assert conn.overflowed is True
    # Subsequent attempts also refuse without growing the queue.
    assert mgr.enqueue(conn, {"v": 1, "type": "pong", "server_time": -1}) is False


async def test_run_sender_drains_in_order_and_stops_on_close_sentinel() -> None:
    mgr = ConnectionManager()
    conn = _new_conn()
    mgr.register(conn)
    mgr.enqueue(conn, {"v": 1, "type": "pong", "server_time": 1})
    mgr.enqueue(conn, {"v": 1, "type": "pong", "server_time": 2})
    sender = asyncio.create_task(mgr.run_sender(conn))
    await asyncio.sleep(0)  # let sender drain once
    await mgr.request_close(conn)
    await asyncio.wait_for(sender, timeout=1.0)

    ws = conn.ws  # type: ignore[assignment]
    assert isinstance(ws, FakeWS)
    assert [json.loads(p)["server_time"] for p in ws.sent] == [1, 2]


async def test_run_sender_closes_ws_with_1011_on_overflow() -> None:
    mgr = ConnectionManager()
    conn = _new_conn()
    mgr.register(conn)
    conn.overflowed = True  # simulate prior detection
    sender = asyncio.create_task(mgr.run_sender(conn))
    await asyncio.wait_for(sender, timeout=1.0)
    ws = conn.ws
    assert isinstance(ws, FakeWS)
    assert ws.closed_with == (1011, "backpressure_overflow")
