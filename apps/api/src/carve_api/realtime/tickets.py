# Armin Mehri — mehri.armin@gmail.com
"""One-time WebSocket auth tickets.

Why tickets and not "JWT in query string":

  * Query-string JWTs end up in nginx access logs, browser history and
    referrer headers. Even short-lived access tokens are too sensitive
    to leak this way.
  * Tickets are scoped to ``(user_id, task_id)`` — leak protection +
    authorisation in one shot. Trying to upgrade a ticket against a
    different task gets a clean ``ticket_task_mismatch`` error.
  * Consume-on-use prevents replay if a ticket somehow does leak: the
    server ``GETDEL``s it during the WS handshake, so a second
    connection attempt with the same ticket fails.

Lifecycle:

  1. Authenticated REST call ``POST /realtime/ticket`` issues a 32-byte
     URL-safe token, stores ``json(user_id, task_id, issued_at)`` at
     ``rt:ticket:{token}`` with TTL :data:`TICKET_TTL_SECONDS` and
     returns ``{ticket, expires_in}``.
  2. Client opens ``WS /realtime/ws/{task_id}?ticket=<token>``. The
     server atomically reads + deletes the key (``GETDEL``). Missing /
     expired ticket → close 4401.
  3. Server verifies ``task_id`` in the URL matches the ticket's
     payload, then upgrades.
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from dataclasses import dataclass

import redis.asyncio as aioredis

from carve_api.config import get_settings

# 30s is enough for a healthy browser to exchange a REST response and
# open a WS upgrade. Short window keeps the attack surface minimal.
TICKET_TTL_SECONDS = 30


def _key(token: str) -> str:
    return f"rt:ticket:{token}"


@dataclass(slots=True)
class TicketPayload:
    user_id: uuid.UUID
    task_id: uuid.UUID
    issued_at: int  # epoch seconds


# Module-level client; created lazily.
_client: aioredis.Redis | None = None


def _get_client() -> aioredis.Redis:
    global _client
    if _client is None:
        s = get_settings()
        _client = aioredis.Redis(
            host=s.redis_host,
            port=s.redis_port,
            decode_responses=True,
        )
    return _client


def set_client_for_test(client: aioredis.Redis | None) -> None:
    """Replace (or clear) the module client. Tests only."""
    global _client
    _client = client


async def issue_ticket(user_id: uuid.UUID, task_id: uuid.UUID) -> str:
    """Mint a fresh ticket bound to (user, task). Returns the token."""
    token = secrets.token_urlsafe(32)
    payload = json.dumps(
        {
            "user_id": str(user_id),
            "task_id": str(task_id),
            "issued_at": int(time.time()),
        },
        separators=(",", ":"),
    )
    # ``EX`` sets TTL atomically with SET; ``NX`` not strictly needed
    # because token_urlsafe collisions are vanishingly unlikely, but
    # included to make the contract explicit.
    await _get_client().set(_key(token), payload, ex=TICKET_TTL_SECONDS, nx=True)
    return token


async def consume_ticket(token: str) -> TicketPayload | None:
    """Atomically claim and decode a ticket. Returns ``None`` for
    missing / expired / malformed tokens."""
    if not token or len(token) > 128:
        return None
    # ``GETDEL`` (Redis 6.2+) is atomic; we never leave a half-consumed
    # ticket behind.
    raw = await _get_client().getdel(_key(token))
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        return TicketPayload(
            user_id=uuid.UUID(data["user_id"]),
            task_id=uuid.UUID(data["task_id"]),
            issued_at=int(data["issued_at"]),
        )
    except (ValueError, KeyError, TypeError):
        return None
