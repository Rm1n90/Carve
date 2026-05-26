# Armin Mehri — mehri.armin@gmail.com
"""End-to-end smoke for the Phase 1 realtime endpoints.

The full membership-check round-trip (register → project → task →
ticket → WS) needs Postgres *and* Redis. Skipped automatically when
either is unavailable.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app
from carve_api.realtime.schemas import ErrorCode

pytestmark = pytest.mark.usefixtures("require_redis")


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
