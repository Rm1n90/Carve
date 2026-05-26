# Armin Mehri — mehri.armin@gmail.com
"""Ticket issue + consume happy-path and replay protection.

Skipped automatically if Redis isn't reachable.
"""

from __future__ import annotations

import uuid

import pytest

from carve_api.realtime.tickets import (
    TICKET_TTL_SECONDS,
    consume_ticket,
    issue_ticket,
    set_client_for_test,
)

pytestmark = pytest.mark.usefixtures("require_redis")


@pytest.fixture(autouse=True)
def _bind_client(aredis):
    """Bind the module-level async client to the test's cleanup-scoped
    instance so we don't leak Redis state across tests."""
    set_client_for_test(aredis)
    try:
        yield
    finally:
        set_client_for_test(None)


async def test_issue_then_consume_returns_payload() -> None:
    user, task = uuid.uuid4(), uuid.uuid4()
    token = await issue_ticket(user, task)
    assert isinstance(token, str) and len(token) >= 32
    payload = await consume_ticket(token)
    assert payload is not None
    assert payload.user_id == user
    assert payload.task_id == task


async def test_consume_twice_returns_none_the_second_time() -> None:
    token = await issue_ticket(uuid.uuid4(), uuid.uuid4())
    first = await consume_ticket(token)
    assert first is not None
    # Replay attempt — ``GETDEL`` removed the key on the first read.
    again = await consume_ticket(token)
    assert again is None


async def test_consume_unknown_token_returns_none() -> None:
    assert await consume_ticket("does-not-exist") is None


async def test_consume_empty_or_too_long_token_returns_none() -> None:
    assert await consume_ticket("") is None
    assert await consume_ticket("a" * 129) is None


async def test_ticket_ttl_is_thirty_seconds(aredis) -> None:
    # The TTL is a security knob; if it changes the value must be
    # noticed in review.
    assert TICKET_TTL_SECONDS == 30
    token = await issue_ticket(uuid.uuid4(), uuid.uuid4())
    ttl = await aredis.ttl(f"rt:ticket:{token}")
    # Should be within the configured window (Redis returns an int).
    assert 0 < ttl <= TICKET_TTL_SECONDS
