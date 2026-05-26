# Armin Mehri — mehri.armin@gmail.com
"""Async Redis pub/sub bus for the realtime collaboration channel.

Each task has three Redis keys:

  * ``rt:task:{id}:seq``     — ``INCR``-only counter producing a strict
                                monotonic event sequence. Clients use it
                                to detect dropped events (gap → resync).
  * ``rt:task:{id}:replay``  — bounded list of the last
                                ``REPLAY_BUFFER_SIZE`` envelopes (LPUSH
                                newest at index 0). 5-minute TTL bumped
                                on every publish so an idle task does
                                not keep state forever.
  * channel ``rt:task:{id}:bus`` — pub/sub fan-out for connected WS
                                handlers.

Why this shape rather than a Postgres event log:

  * v1 only needs short-window resume (a few seconds dropped during a
    network blip). 5 min × 200 events is plenty in practice for a single
    user. If the gap is wider we force a full re-fetch from the existing
    ``GET /tasks/{id}/annotations`` endpoint — correctness over cleverness.
  * No new migration → smaller blast radius for the first PR.

Concurrency model: ``INCR`` produces a fresh seq, then a pipelined
``LPUSH → LTRIM → EXPIRE → PUBLISH`` commits the body and fans it out.
Subscribers connected at publish time receive frames in the order Redis
PUBLISH dispatches them. The seq inside each frame is the canonical
ordering signal — clients ignore wall-clock for ordering.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import redis.asyncio as aioredis

from carve_api.config import get_settings

# --- Constants ---------------------------------------------------------------

# Last 200 events kept for resume-on-reconnect. Sized for a single
# user editing fast (~few events/sec) over a multi-minute drop. If a
# client's ``last_event_seq`` falls outside this window the server
# tells it to resync.
REPLAY_BUFFER_SIZE = 200

# How long Redis keeps replay/seq state after the last publish. Tasks
# idle longer than this lose their seq counter — that's intentional
# (clients reconnecting after a true idle window will receive a small
# ``last_event_seq`` from the next ``hello`` and treat it as a cold
# start).
REPLAY_TTL_SECONDS = 5 * 60


def _key_seq(task_id: uuid.UUID) -> str:
    return f"rt:task:{task_id}:seq"


def _key_replay(task_id: uuid.UUID) -> str:
    return f"rt:task:{task_id}:replay"


def _channel(task_id: uuid.UUID) -> str:
    return f"rt:task:{task_id}:bus"


# --- Envelope ----------------------------------------------------------------


@dataclass(slots=True)
class EventEnvelope:
    """In-transit shape of a single bus message.

    ``payload`` is the un-namespaced server→client message body (e.g.
    ``{"type": "ops:upsert", "annotation": …}``); the publisher stamps
    ``seq`` and the wall-clock ``ts`` (epoch ms) at publish time so all
    subscribers see consistent values.
    """

    seq: int
    ts: int
    payload: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, "ts": self.ts, "payload": self.payload}

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> EventEnvelope:
        return cls(seq=int(raw["seq"]), ts=int(raw["ts"]), payload=dict(raw["payload"]))


# --- Bus ---------------------------------------------------------------------


class RealtimeBus:
    """Thin façade over ``redis.asyncio`` for the realtime channel.

    Constructed once per process — :func:`get_bus` returns a lazily
    initialised singleton. Tests may inject a fake client by calling
    ``RealtimeBus(client=fake)``.
    """

    def __init__(self, client: aioredis.Redis | None = None) -> None:
        self._client = client
        self._owns_client = client is None

    def _get_client(self) -> aioredis.Redis:
        if self._client is None:
            s = get_settings()
            # ``decode_responses=True`` so PUBSUB delivers ``str`` directly.
            self._client = aioredis.Redis(
                host=s.redis_host,
                port=s.redis_port,
                decode_responses=True,
            )
        return self._client

    async def aclose(self) -> None:
        """Close the underlying client (test cleanup)."""
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def publish(
        self,
        task_id: uuid.UUID,
        payload: dict[str, Any],
        *,
        now_ms: int | None = None,
    ) -> EventEnvelope:
        """Stamp + persist + fan out one message. Returns the envelope.

        Atomic: a subscriber that connected before the call either sees
        nothing (publish failed) or sees one PUBLISH frame *and* finds
        the same seq inside the replay buffer.
        """
        client = self._get_client()
        ts = now_ms if now_ms is not None else _now_ms()
        seq = int(await client.incr(_key_seq(task_id)))
        envelope = EventEnvelope(seq=seq, ts=ts, payload=payload)
        encoded = json.dumps(envelope.to_dict(), separators=(",", ":"))
        # One transaction so subscribers receiving the PUBLISH find the
        # same seq in the replay buffer if they then call LRANGE.
        async with client.pipeline(transaction=True) as pipe:
            pipe.lpush(_key_replay(task_id), encoded)
            pipe.ltrim(_key_replay(task_id), 0, REPLAY_BUFFER_SIZE - 1)
            pipe.expire(_key_replay(task_id), REPLAY_TTL_SECONDS)
            pipe.expire(_key_seq(task_id), REPLAY_TTL_SECONDS)
            pipe.publish(_channel(task_id), encoded)
            await pipe.execute()
        return envelope

    async def current_seq(self, task_id: uuid.UUID) -> int:
        """Return the highest seq the bus has ever published for this
        task in the current Redis epoch, or ``0`` if none."""
        raw = await self._get_client().get(_key_seq(task_id))
        return int(raw) if raw is not None else 0

    async def replay_since(
        self,
        task_id: uuid.UUID,
        last_seq: int,
    ) -> tuple[list[EventEnvelope], bool]:
        """Return events newer than ``last_seq`` along with a *gap* flag.

        The gap flag is ``True`` when the buffer's oldest event has a
        seq greater than ``last_seq + 1``, meaning the client missed
        events that have already aged out. The caller should treat that
        as a forced resync.
        """
        raw_items = await self._get_client().lrange(
            _key_replay(task_id), 0, REPLAY_BUFFER_SIZE - 1
        )
        envelopes: list[EventEnvelope] = []
        for raw in raw_items:
            try:
                envelopes.append(EventEnvelope.from_dict(json.loads(raw)))
            except (ValueError, KeyError, TypeError):
                # Defensive: skip corrupt entries rather than crash the WS.
                continue
        envelopes.sort(key=lambda e: e.seq)
        newer = [e for e in envelopes if e.seq > last_seq]
        gap = False
        if envelopes and last_seq > 0:
            # Oldest seq in buffer must be <= last_seq + 1 for the
            # client to be caught up by replay alone.
            oldest = envelopes[0].seq
            if oldest > last_seq + 1:
                gap = True
        return newer, gap

    async def subscribe(
        self,
        task_id: uuid.UUID,
    ) -> AsyncIterator[EventEnvelope]:
        """Yield envelopes published to ``task_id`` until cancelled.

        Caller is responsible for cancellation (e.g. cancelling the
        consumer task on disconnect).
        """
        pubsub = self._get_client().pubsub()
        await pubsub.subscribe(_channel(task_id))
        try:
            while True:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=None,
                )
                if msg is None:
                    # ``timeout=None`` blocks until a message arrives;
                    # ``None`` only surfaces on connection drop. Yield
                    # control so cancellation can land.
                    await asyncio.sleep(0)
                    continue
                if msg.get("type") != "message":
                    continue
                data = msg.get("data")
                if not isinstance(data, str):
                    continue
                try:
                    envelope = EventEnvelope.from_dict(json.loads(data))
                except (ValueError, KeyError, TypeError):
                    continue
                yield envelope
        finally:
            try:
                await pubsub.unsubscribe(_channel(task_id))
            finally:
                await pubsub.aclose()


def _now_ms() -> int:
    """Wall-clock epoch milliseconds. Wrapped so tests can monkeypatch."""
    import time

    return int(time.time() * 1000)


# --- Singleton accessor ------------------------------------------------------

_bus: RealtimeBus | None = None


def get_bus() -> RealtimeBus:
    """Process-wide singleton bus."""
    global _bus
    if _bus is None:
        _bus = RealtimeBus()
    return _bus


def reset_bus_for_test(client: aioredis.Redis | None = None) -> RealtimeBus:
    """Swap the singleton with a fresh instance (or one bound to a
    test-provided client). Use only from tests."""
    global _bus
    _bus = RealtimeBus(client=client)
    return _bus
