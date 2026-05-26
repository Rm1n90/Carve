# Armin Mehri — mehri.armin@gmail.com
"""End-to-end smoke for the Phase 1 realtime endpoints.

The full membership-check round-trip (register → project → task →
ticket → WS) needs Postgres *and* Redis. Skipped automatically when
either is unavailable.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import queue as _queue
import time
import uuid

import pytest
import redis.asyncio as _aioredis
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.realtime.bus import get_bus
from carve_api.realtime.schemas import ErrorCode

pytestmark = pytest.mark.usefixtures("require_redis")

# Minimal 1x1 PNG so we can upload one asset without touching real
# image bytes. Same blob used in the annotations router tests.
_TINY_PNG = bytes.fromhex(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
    "0000000A4944415478DA63000000000200015C8B59FA0000000049454E44AE426082"
)


def _client(db_session):
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _bootstrap_user_and_task(client: TestClient) -> tuple[str, str]:
    """Create a user + project + task. Returns (token, task_id)."""
    client.post(
        "/auth/register", json={"email": "rt@x.com", "password": "hunter22"}
    )
    token = client.post(
        "/auth/login", json={"email": "rt@x.com", "password": "hunter22"}
    ).json()["access_token"]
    pid = client.post(
        "/projects", json={"name": "RT"}, headers=_hdr(token)
    ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    return token, tid


def _stub_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace the MinIO client with an in-memory fake so the asset
    upload that backs the realtime mutation tests can run without a
    real object store."""
    from carve_api.assets import service as svc_mod

    class _FakeStorage:
        @classmethod
        def from_settings(cls) -> _FakeStorage:
            return cls()

        def ensure_bucket(self) -> None:
            return None

        def put_object(self, *_args: object, **_kwargs: object) -> None:
            return None

        def get_object(self, _key: str) -> io.BytesIO:
            return io.BytesIO(b"")

        def remove_object(self, _key: str) -> None:
            return None

        def presigned_get(self, key: str, **_kwargs: object) -> str:
            return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)


def _bootstrap_with_asset_and_class(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, str, str, str, str]:
    """Full bootstrap for realtime mutation tests.

    Returns ``(token, task_id, class_id, asset_id, frame_id)`` —
    enough to POST a bbox via ``/tasks/{task_id}/annotations``.
    """
    _stub_storage(monkeypatch)
    token, tid = _bootstrap_user_and_task(client)
    pid = client.get("/projects", headers=_hdr(token)).json()[0]["id"]
    cid = client.post(
        f"/projects/{pid}/classes",
        json={"idx": 0, "name": "logo", "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]
    aid = client.post(
        f"/tasks/{tid}/assets",
        files={"file": ("a.png", io.BytesIO(_TINY_PNG), "image/png")},
        headers=_hdr(token),
    ).json()["id"]
    fid = client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]
    return token, tid, cid, aid, fid


def _bbox_payload(frame_id: str, class_id: str) -> dict:
    return {
        "frame_id": frame_id,
        "class_id": class_id,
        "kind": "bbox",
        "geometry": {"kind": "bbox", "x": 1, "y": 2, "w": 10, "h": 20},
    }


def _recv_with_timeout(ws, timeout: float = 3.0) -> dict:
    """Receive a JSON message off a WS, failing the test on timeout.

    Starlette's TestClient blocks indefinitely on ``receive_json``. The
    bus + sender chain *should* be sub-second; if it takes longer
    something is wrong (subscribe race, sender stalled, etc.).
    """

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return ws.receive_json()
        except _queue.Empty:
            continue
    raise AssertionError(f"timeout after {timeout}s waiting for ws message")


def test_post_ticket_requires_auth(db_session) -> None:
    client = _client(db_session)
    r = client.post(
        "/realtime/ticket",
        json={"task_id": "11111111-1111-1111-1111-111111111111"},
    )
    assert r.status_code == 401


def test_post_ticket_happy_path_returns_token(db_session) -> None:
    client = _client(db_session)
    token, tid = _bootstrap_user_and_task(client)
    r = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["ticket"], str) and len(body["ticket"]) >= 32
    assert body["expires_in"] == 30


def test_ws_rejects_bogus_ticket(db_session) -> None:
    client = _client(db_session)
    _token, tid = _bootstrap_user_and_task(client)
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as ex:
        with client.websocket_connect(
            f"/realtime/ws/{tid}?ticket=this-is-not-a-real-token"
        ):
            pass
    # Code 4401 is our application-level "invalid ticket" close code.
    assert ex.value.code == 4401


def test_ws_happy_path_sends_hello_and_responds_to_ping(db_session) -> None:
    client = _client(db_session)
    token, tid = _bootstrap_user_and_task(client)
    # Mint a real ticket via the REST endpoint — that exercises the
    # full ``require_visible_task`` membership path.
    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]

    with client.websocket_connect(
        f"/realtime/ws/{tid}?ticket={ticket}"
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["v"] == 1
        assert hello["task_id"] == tid
        assert isinstance(hello["session_id"], str)
        assert hello["presence"] == []  # Phase 1 — empty
        # Round-trip a ping.
        ws.send_text(json.dumps({"v": 1, "type": "ping"}))
        pong = ws.receive_json()
        assert pong["type"] == "pong"
        assert pong["v"] == 1
        assert isinstance(pong["server_time"], int)


def test_ws_replies_with_error_on_bad_json(db_session) -> None:
    client = _client(db_session)
    token, tid = _bootstrap_user_and_task(client)
    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(
        f"/realtime/ws/{tid}?ticket={ticket}"
    ) as ws:
        ws.receive_json()  # drain hello
        ws.send_text("not json at all")
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == ErrorCode.INVALID_PAYLOAD


def test_ws_replies_with_error_on_unknown_type(db_session) -> None:
    client = _client(db_session)
    token, tid = _bootstrap_user_and_task(client)
    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(
        f"/realtime/ws/{tid}?ticket={ticket}"
    ) as ws:
        ws.receive_json()  # drain hello
        ws.send_text(json.dumps({"v": 1, "type": "not-a-real-type"}))
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == ErrorCode.UNKNOWN_TYPE


# --- Phase 2: cross-client data sync ----------------------------------------


def test_two_clients_cross_pollinate_and_echo_is_suppressed(
    db_session, monkeypatch
) -> None:
    """A creates → B receives ops:upsert. A does NOT receive its own
    echo (suppressed via X-Origin-Session). Then B creates → A
    receives — proving the channel is bidirectional and the suppression
    is per-session, not a blanket A-never-sees-anything bug.
    """
    client = _client(db_session)
    token, tid, cid, _aid, fid = _bootstrap_with_asset_and_class(client, monkeypatch)

    def _mint() -> str:
        return client.post(
            "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
        ).json()["ticket"]

    ticket_a, ticket_b = _mint(), _mint()
    with (
        client.websocket_connect(f"/realtime/ws/{tid}?ticket={ticket_a}") as ws_a,
        client.websocket_connect(f"/realtime/ws/{tid}?ticket={ticket_b}") as ws_b,
    ):
        hello_a = ws_a.receive_json()
        hello_b = ws_b.receive_json()
        assert hello_a["type"] == "hello" and hello_b["type"] == "hello"
        session_a = hello_a["session_id"]
        session_b = hello_b["session_id"]
        assert session_a != session_b

        # A creates an annotation, tagged with its own origin-session.
        r = client.post(
            f"/tasks/{tid}/annotations",
            json=_bbox_payload(fid, cid),
            headers={**_hdr(token), "X-Origin-Session": session_a},
        )
        assert r.status_code == 201, r.text
        ann = r.json()

        # B sees the upsert (cross-pollination works).
        msg_b = _recv_with_timeout(ws_b)
        assert msg_b["type"] == "ops:upsert"
        assert msg_b["annotation"]["id"] == ann["id"]
        assert msg_b["origin_session"] == session_a
        # Bus stamped seq + ts.
        assert isinstance(msg_b["seq"], int) and msg_b["seq"] > 0
        assert isinstance(msg_b["ts"], int)

        # Now B creates — A receives. Proves A's subscriber is alive
        # AND wasn't poisoned by the suppressed echo.
        r2 = client.post(
            f"/tasks/{tid}/annotations",
            json=_bbox_payload(fid, cid),
            headers={**_hdr(token), "X-Origin-Session": session_b},
        )
        assert r2.status_code == 201, r2.text
        ann2 = r2.json()
        msg_a = _recv_with_timeout(ws_a)
        assert msg_a["type"] == "ops:upsert"
        assert msg_a["annotation"]["id"] == ann2["id"]
        assert msg_a["origin_session"] == session_b
        # Seq is monotonic across the two publishes.
        assert msg_a["seq"] > msg_b["seq"]


def test_delete_broadcasts_ops_delete(db_session, monkeypatch) -> None:
    """DELETE /annotations/{id} → other clients receive ops:delete."""
    client = _client(db_session)
    token, tid, cid, _aid, fid = _bootstrap_with_asset_and_class(client, monkeypatch)

    # Pre-create an annotation off the realtime channel so the WS
    # below doesn't see its create event.
    ann = client.post(
        f"/tasks/{tid}/annotations",
        json=_bbox_payload(fid, cid),
        headers=_hdr(token),
    ).json()

    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(f"/realtime/ws/{tid}?ticket={ticket}") as ws:
        ws.receive_json()  # drain hello
        # Delete from a non-WS client (no X-Origin-Session → no
        # suppression, so this connection sees it).
        r = client.delete(
            f"/annotations/{ann['id']}", headers=_hdr(token)
        )
        assert r.status_code == 204
        msg = _recv_with_timeout(ws)
        assert msg["type"] == "ops:delete"
        assert msg["annotation_id"] == ann["id"]


def test_batch_broadcasts_ops_batch(db_session, monkeypatch) -> None:
    """POST :batch with a mix of create + delete → ops:batch carrying
    self-describing entries for each."""
    client = _client(db_session)
    token, tid, cid, _aid, fid = _bootstrap_with_asset_and_class(client, monkeypatch)

    # Pre-create one annotation so the batch can delete it.
    existing = client.post(
        f"/tasks/{tid}/annotations",
        json=_bbox_payload(fid, cid),
        headers=_hdr(token),
    ).json()

    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(f"/realtime/ws/{tid}?ticket={ticket}") as ws:
        ws.receive_json()  # drain hello
        r = client.post(
            f"/tasks/{tid}/annotations:batch",
            json={
                "create": [_bbox_payload(fid, cid)],
                "update": [],
                "delete": [existing["id"]],
            },
            headers=_hdr(token),
        )
        assert r.status_code == 200, r.text
        msg = _recv_with_timeout(ws)
        assert msg["type"] == "ops:batch"
        types = [op["type"] for op in msg["ops"]]
        assert "ops:upsert" in types and "ops:delete" in types
        # Delete op points at the existing annotation.
        delete_ops = [op for op in msg["ops"] if op["type"] == "ops:delete"]
        assert delete_ops[0]["annotation_id"] == existing["id"]


def test_reconnect_with_last_event_seq_replays_missed_events(
    db_session, monkeypatch
) -> None:
    """Reconnecting with the previous ``last_event_seq`` should replay
    every event the bus still has buffered for this task — the
    contract for "I dropped network for a few seconds, catch me up"."""
    client = _client(db_session)
    token, tid, cid, _aid, fid = _bootstrap_with_asset_and_class(client, monkeypatch)

    # First session: connect, get hello.last_event_seq, then disconnect.
    ticket_1 = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(f"/realtime/ws/{tid}?ticket={ticket_1}") as ws:
        hello = ws.receive_json()
    baseline = hello["last_event_seq"]

    # Mutations happen while the client is offline.
    a1 = client.post(
        f"/tasks/{tid}/annotations",
        json=_bbox_payload(fid, cid),
        headers=_hdr(token),
    ).json()
    a2 = client.post(
        f"/tasks/{tid}/annotations",
        json=_bbox_payload(fid, cid),
        headers=_hdr(token),
    ).json()

    # Reconnect with last_event_seq = baseline → server should replay
    # both upserts before any live message.
    ticket_2 = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(
        f"/realtime/ws/{tid}?ticket={ticket_2}&last_event_seq={max(baseline, 1)}"
    ) as ws:
        ws.receive_json()  # drain hello
        # We pre-mutated the bus by 2 events; replay should deliver
        # both before any live message arrives.
        msg1 = _recv_with_timeout(ws)
        msg2 = _recv_with_timeout(ws)
        replayed_ids = {msg1["annotation"]["id"], msg2["annotation"]["id"]}
        assert replayed_ids == {a1["id"], a2["id"]}
        assert msg1["seq"] < msg2["seq"]


def test_reconnect_with_stale_seq_triggers_resync(db_session, monkeypatch) -> None:
    """When the buffer's oldest seq is > ``last_event_seq + 1``, the
    client can't be brought up to date from the replay alone. The
    server must send a ``resync`` envelope so the client refetches
    annotations via REST."""
    client = _client(db_session)
    token, tid, _cid, _aid, _fid = _bootstrap_with_asset_and_class(client, monkeypatch)

    # Drive the bus past whatever previous state and then force a gap
    # by clearing the replay buffer while preserving the seq counter.
    # Using the same keys the bus owns so the bus sees the simulated
    # "buffer aged out" state.
    actor_zero = "00000000-0000-0000-0000-000000000000"

    async def _force_gap() -> None:
        r = _aioredis.Redis(
            host=os.environ.get("REDIS_HOST", "localhost"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        try:
            bus = get_bus()
            # Publish 3 events through the bus so the seq counter
            # advances past 1.
            for _ in range(3):
                await bus.publish(
                    uuid.UUID(tid),
                    {
                        "type": "ops:upsert",
                        "annotation": {"id": "x"},
                        "actor_id": actor_zero,
                        "origin_session": None,
                    },
                )
            # Wipe the replay buffer but NOT the seq counter so the
            # next publish lands at seq=4 in an otherwise-empty
            # buffer — exactly the "older events aged out" state.
            await r.delete(f"rt:task:{tid}:replay")
            await bus.publish(
                uuid.UUID(tid),
                {
                    "type": "ops:upsert",
                    "annotation": {"id": "y"},
                    "actor_id": actor_zero,
                    "origin_session": None,
                },
            )
        finally:
            await r.aclose()

    asyncio.run(_force_gap())

    # Now reconnect with last_event_seq=1. Buffer oldest is 4
    # (post-DELETE), so gap=True and the server should send a resync.
    ticket = client.post(
        "/realtime/ticket", json={"task_id": tid}, headers=_hdr(token)
    ).json()["ticket"]
    with client.websocket_connect(
        f"/realtime/ws/{tid}?ticket={ticket}&last_event_seq=1"
    ) as ws:
        ws.receive_json()  # drain hello
        msg = _recv_with_timeout(ws)
        assert msg["type"] == "resync"
        assert msg["reason"] == "gap_replay"
