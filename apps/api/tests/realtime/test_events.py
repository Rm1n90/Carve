# Armin Mehri — mehri.armin@gmail.com
"""Unit tests for the realtime event emitters.

No Redis: we monkeypatch ``get_bus`` with an in-memory fake so we can
assert on the exact payload shape that hits ``bus.publish``. The
emitters themselves don't talk to Redis directly — they only call the
bus — so testing the wire shape this way is sufficient.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from carve_api.realtime import events as ev
from carve_api.realtime.bus import EventEnvelope
from carve_api.realtime.schemas import PROTOCOL_VERSION


class _FakeBus:
    """Captures every publish call. Mirrors the slice of the real bus
    the emitters use (``publish`` only)."""

    def __init__(self) -> None:
        self.published: list[tuple[uuid.UUID, dict[str, Any]]] = []
        self.fail_next = False

    async def publish(
        self,
        task_id: uuid.UUID,
        payload: dict[str, Any],
        *,
        now_ms: int | None = None,
    ) -> EventEnvelope:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("simulated redis outage")
        self.published.append((task_id, payload))
        return EventEnvelope(seq=len(self.published), ts=0, payload=payload)


@pytest.fixture
def fake_bus(monkeypatch: pytest.MonkeyPatch) -> _FakeBus:
    fake = _FakeBus()
    monkeypatch.setattr(ev, "get_bus", lambda: fake)
    return fake


async def test_emit_ops_upsert_publishes_expected_shape(fake_bus: _FakeBus) -> None:
    user, task, origin = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    annotation = {"id": str(uuid.uuid4()), "kind": "bbox", "geometry": {}}
    await ev.emit_ops_upsert(
        task_id=task,
        annotation=annotation,
        actor_id=user,
        origin_session=origin,
    )
    assert len(fake_bus.published) == 1
    pub_task, pub_payload = fake_bus.published[0]
    assert pub_task == task
    assert pub_payload == {
        "v": PROTOCOL_VERSION,
        "type": "ops:upsert",
        "annotation": annotation,
        "actor_id": str(user),
        "origin_session": str(origin),
    }


async def test_emit_ops_upsert_serialises_none_origin(fake_bus: _FakeBus) -> None:
    # Non-realtime callers (CLI, jobs) won't have a session; the
    # broadcast must still go out with a literal null so subscribers
    # don't accidentally treat "missing" as their own session.
    await ev.emit_ops_upsert(
        task_id=uuid.uuid4(),
        annotation={"id": "x"},
        actor_id=uuid.uuid4(),
        origin_session=None,
    )
    _, payload = fake_bus.published[0]
    assert payload["origin_session"] is None


async def test_emit_ops_delete_publishes_id_only(fake_bus: _FakeBus) -> None:
    user, task, origin = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ann_id = uuid.uuid4()
    await ev.emit_ops_delete(
        task_id=task,
        annotation_id=ann_id,
        actor_id=user,
        origin_session=origin,
    )
    _, payload = fake_bus.published[0]
    assert payload == {
        "v": PROTOCOL_VERSION,
        "type": "ops:delete",
        "annotation_id": str(ann_id),
        "actor_id": str(user),
        "origin_session": str(origin),
    }


async def test_emit_ops_batch_publishes_ops_list(fake_bus: _FakeBus) -> None:
    user, task = uuid.uuid4(), uuid.uuid4()
    ops = [
        ev.make_upsert_op({"id": "a"}),
        ev.make_delete_op(uuid.uuid4()),
    ]
    await ev.emit_ops_batch(
        task_id=task,
        ops=ops,
        actor_id=user,
        origin_session=None,
    )
    _, payload = fake_bus.published[0]
    assert payload["type"] == "ops:batch"
    assert payload["ops"] == ops
    assert payload["v"] == PROTOCOL_VERSION


async def test_emit_ops_batch_skips_publish_when_ops_empty(fake_bus: _FakeBus) -> None:
    # A batch route that did pure validation (no creates / no deletes)
    # would otherwise emit empty noise to every connected client.
    await ev.emit_ops_batch(
        task_id=uuid.uuid4(),
        ops=[],
        actor_id=uuid.uuid4(),
        origin_session=None,
    )
    assert fake_bus.published == []


async def test_emit_swallows_publish_errors(
    fake_bus: _FakeBus, caplog: pytest.LogCaptureFixture
) -> None:
    # Realtime is an enhancement — a flaky Redis must not break a real
    # annotation write. The emitter catches and logs.
    fake_bus.fail_next = True
    with caplog.at_level("WARNING"):
        await ev.emit_ops_upsert(
            task_id=uuid.uuid4(),
            annotation={"id": "x"},
            actor_id=uuid.uuid4(),
            origin_session=None,
        )
    # No payload reached the bus (publish raised).
    assert fake_bus.published == []
    # The warning was recorded.
    assert any("ops:upsert publish failed" in r.message for r in caplog.records)


def test_make_upsert_op_shape() -> None:
    op = ev.make_upsert_op({"id": "a"})
    assert op == {"type": "ops:upsert", "annotation": {"id": "a"}}


def test_make_delete_op_stringifies_uuid() -> None:
    aid = uuid.uuid4()
    assert ev.make_delete_op(aid) == {"type": "ops:delete", "annotation_id": str(aid)}
    # Already-string ids round-trip unchanged.
    assert ev.make_delete_op("manual-id") == {
        "type": "ops:delete",
        "annotation_id": "manual-id",
    }
