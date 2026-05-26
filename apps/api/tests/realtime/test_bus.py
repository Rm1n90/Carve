# Armin Mehri — mehri.armin@gmail.com
"""Bus tests against a real Redis instance.

Skipped automatically if Redis isn't reachable. Each test uses a fresh
``task_id`` so they don't interfere even though the conftest cleans
``rt:*`` on teardown.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from carve_api.realtime.bus import REPLAY_BUFFER_SIZE, RealtimeBus

pytestmark = pytest.mark.usefixtures("require_redis")


async def test_publish_increments_seq_and_persists_to_replay(aredis) -> None:
    bus = RealtimeBus(client=aredis)
    task = uuid.uuid4()
    e1 = await bus.publish(task, {"type": "ops:upsert", "annotation": {"id": "x"}})
    e2 = await bus.publish(task, {"type": "ops:delete", "annotation_id": "x"})
    assert e1.seq == 1
    assert e2.seq == 2
    assert await bus.current_seq(task) == 2

    newer, gap = await bus.replay_since(task, last_seq=0)
    assert [e.seq for e in newer] == [1, 2]
    assert gap is False


async def test_replay_since_returns_only_newer(aredis) -> None:
    bus = RealtimeBus(client=aredis)
    task = uuid.uuid4()
    for _ in range(3):
        await bus.publish(task, {"type": "pong", "server_time": 0})
    newer, gap = await bus.replay_since(task, last_seq=2)
    assert [e.seq for e in newer] == [3]
    assert gap is False


async def test_replay_detects_gap_when_last_seq_predates_buffer(aredis) -> None:
    bus = RealtimeBus(client=aredis)
    task = uuid.uuid4()
    # Force the seq beyond the buffer window so older events are LTRIMmed.
    # The buffer caps at REPLAY_BUFFER_SIZE; we just need the *oldest*
    # surviving seq to exceed last_seq + 1.
    total = REPLAY_BUFFER_SIZE + 5
    for _ in range(total):
        await bus.publish(task, {"type": "pong", "server_time": 0})
    # last_seq=1 is older than the oldest event still in the buffer
    # (which is seq=total-REPLAY_BUFFER_SIZE+1 = 6).
    newer, gap = await bus.replay_since(task, last_seq=1)
    assert gap is True
    # We still return the buffered tail so the client can debug; the
    # gap flag is what tells it to do a full resync.
    assert len(newer) == REPLAY_BUFFER_SIZE


async def test_subscribe_delivers_published_envelope(aredis) -> None:
    bus = RealtimeBus(client=aredis)
    task = uuid.uuid4()

    received: list[int] = []

    async def consumer() -> None:
        async for env in bus.subscribe(task):
            received.append(env.seq)
            if len(received) >= 2:
                return

    consumer_task = asyncio.create_task(consumer())
    # Give the subscribe a tick to settle before publishing — Redis
    # PUBSUB only delivers to subscribers connected at publish time.
    await asyncio.sleep(0.05)
    await bus.publish(task, {"type": "pong", "server_time": 1})
    await bus.publish(task, {"type": "pong", "server_time": 2})
    try:
        await asyncio.wait_for(consumer_task, timeout=2.0)
    except TimeoutError:
        consumer_task.cancel()
        pytest.fail(f"timeout waiting for envelopes (got {received!r})")
    assert received == [1, 2]
