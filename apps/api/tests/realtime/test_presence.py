# Armin Mehri — mehri.armin@gmail.com
"""Pure-logic tests for the realtime presence tracker.

No FastAPI, no Redis. Connections use a FakeWS double so the tracker's
broadcasts land on per-connection ``send_queue`` instances we can read
directly. Throttle behaviour is exercised by monkeypatching the
tracker's wall-clock helper.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field

import pytest

from carve_api.realtime import presence as presence_mod
from carve_api.realtime.manager import Connection, ConnectionManager
from carve_api.realtime.presence import (
    CURSOR_BROADCAST_INTERVAL_MS,
    PRESENCE_PALETTE,
    PresenceTracker,
    color_for_user,
)


@dataclass
class FakeWS:
    sent: list[str] = field(default_factory=list)

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        return None


def _new_conn(
    task: uuid.UUID | None = None,
    *,
    user_id: uuid.UUID | None = None,
    user_name: str = "alice",
) -> Connection:
    uid = user_id or uuid.uuid4()
    return Connection(
        session_id=uuid.uuid4(),
        user_id=uid,
        task_id=task or uuid.uuid4(),
        ws=FakeWS(),
        user_name=user_name,
        color=color_for_user(uid),
    )


def _drain(conn: Connection) -> list[dict]:
    """Pop everything in the send queue, decoded."""
    out: list[dict] = []
    while not conn.send_queue.empty():
        try:
            raw = conn.send_queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        out.append(json.loads(raw))
    return out


# ---- color helper -----------------------------------------------------------


def test_color_for_user_is_deterministic() -> None:
    uid = uuid.uuid4()
    assert color_for_user(uid) == color_for_user(uid)


def test_color_for_user_is_in_palette() -> None:
    for _ in range(50):
        c = color_for_user(uuid.uuid4())
        assert c in PRESENCE_PALETTE


def test_color_distribution_is_not_degenerate() -> None:
    # Different user_ids should land on more than one palette entry.
    # 30 random ids → at least 3 distinct colors with overwhelming
    # probability. Pin the loose bound.
    seen = {color_for_user(uuid.uuid4()) for _ in range(30)}
    assert len(seen) >= 3


# ---- snapshot ---------------------------------------------------------------


def test_snapshot_empty_for_unknown_task() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    assert tracker.snapshot(uuid.uuid4()) == []


def test_snapshot_lists_every_other_connection_on_task() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a, b = _new_conn(task, user_name="alice"), _new_conn(task, user_name="bob")
    other = _new_conn()  # different task — must NOT appear
    for c in (a, b, other):
        mgr.register(c)

    snap = tracker.snapshot(task, exclude_session=a.session_id)
    assert len(snap) == 1
    assert snap[0]["session_id"] == str(b.session_id)
    assert snap[0]["name"] == "bob"
    assert snap[0]["color"] in PRESENCE_PALETTE


def test_snapshot_without_exclude_returns_everyone() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a, b = _new_conn(task), _new_conn(task)
    for c in (a, b):
        mgr.register(c)
    snap = tracker.snapshot(task)
    assert len(snap) == 2


# ---- join / leave -----------------------------------------------------------


def test_broadcast_join_reaches_peers_only() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task, user_name="alice")
    b = _new_conn(task, user_name="bob")
    for c in (a, b):
        mgr.register(c)

    delivered = tracker.broadcast_join(a)
    assert delivered == 1  # only b receives
    a_msgs = _drain(a)
    b_msgs = _drain(b)
    assert a_msgs == []  # joiner doesn't echo to itself
    assert len(b_msgs) == 1
    assert b_msgs[0]["type"] == "presence:join"
    assert b_msgs[0]["user"]["session_id"] == str(a.session_id)
    assert b_msgs[0]["user"]["name"] == "alice"


def test_broadcast_leave_reaches_peers_only() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task)
    b = _new_conn(task)
    for c in (a, b):
        mgr.register(c)

    delivered = tracker.broadcast_leave(a)
    assert delivered == 1
    msg = _drain(b)[0]
    assert msg["type"] == "presence:leave"
    assert msg["session_id"] == str(a.session_id)
    assert _drain(a) == []


# ---- cursor throttle --------------------------------------------------------


def test_update_cursor_broadcasts_first_event(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the clock so the test isn't timing-sensitive.
    fixed_now = [1_000_000]
    monkeypatch.setattr(presence_mod, "_now_ms", lambda: fixed_now[0])

    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task)
    b = _new_conn(task)
    for c in (a, b):
        mgr.register(c)

    asset_id = uuid.uuid4()
    sent = tracker.update_cursor(a, asset_id=asset_id, frame_id=None, x=10, y=20)
    assert sent is True
    msg = _drain(b)[0]
    assert msg["type"] == "presence:cursor"
    assert msg["session_id"] == str(a.session_id)
    assert msg["x"] == 10
    assert msg["y"] == 20
    # Sender doesn't see its own cursor.
    assert _drain(a) == []
    # Stored state matches.
    assert a.cursor_x == 10
    assert a.cursor_y == 20


def test_update_cursor_throttled_within_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed_now = [1_000_000]
    monkeypatch.setattr(presence_mod, "_now_ms", lambda: fixed_now[0])

    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task)
    b = _new_conn(task)
    for c in (a, b):
        mgr.register(c)

    asset_id = uuid.uuid4()
    # First broadcast — sent.
    assert tracker.update_cursor(a, asset_id=asset_id, frame_id=None, x=1, y=1) is True
    # Second within the throttle window — suppressed.
    fixed_now[0] += CURSOR_BROADCAST_INTERVAL_MS // 2
    assert tracker.update_cursor(a, asset_id=asset_id, frame_id=None, x=2, y=2) is False
    # Stored cursor still reflects the latest position even though no
    # broadcast went out — critical for any late-joiner's snapshot.
    assert a.cursor_x == 2
    assert a.cursor_y == 2
    # Past the window — sent again.
    fixed_now[0] += CURSOR_BROADCAST_INTERVAL_MS + 1
    assert tracker.update_cursor(a, asset_id=asset_id, frame_id=None, x=3, y=3) is True

    msgs = _drain(b)
    # Exactly two broadcasts reached b.
    assert len(msgs) == 2
    assert [m["x"] for m in msgs] == [1, 3]


# ---- focus ------------------------------------------------------------------


def test_update_focus_broadcasts_and_stores_target() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task)
    b = _new_conn(task)
    for c in (a, b):
        mgr.register(c)

    target = {"kind": "annotation", "id": str(uuid.uuid4())}
    tracker.update_focus(a, target)
    assert a.focus_target == target
    msg = _drain(b)[0]
    assert msg["type"] == "presence:focus"
    assert msg["session_id"] == str(a.session_id)
    assert msg["target"] == target


def test_update_focus_null_clears_state() -> None:
    mgr = ConnectionManager()
    tracker = PresenceTracker(mgr)
    task = uuid.uuid4()
    a = _new_conn(task)
    b = _new_conn(task)
    for c in (a, b):
        mgr.register(c)

    tracker.update_focus(a, {"kind": "annotation", "id": str(uuid.uuid4())})
    tracker.update_focus(a, None)
    assert a.focus_target is None
    msgs = _drain(b)
    assert msgs[-1]["target"] is None
