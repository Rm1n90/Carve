# Armin Mehri — mehri.armin@gmail.com
"""Fixtures + helpers for realtime tests.

Two flavours of tests live in this package:

  * **Pure-logic** (``test_schemas``, ``test_manager``) — no infra.
  * **Redis-backed** (``test_bus``, ``test_tickets``, ``test_router_ws``)
    — gated by :func:`redis_available`. If a Redis instance isn't
    reachable at the configured host/port, those tests are skipped
    rather than failing the whole suite. That mirrors how the
    Postgres-backed tests in the rest of the suite assume a real DB.
"""

from __future__ import annotations

import os

import pytest


def _redis_url_parts() -> tuple[str, int]:
    return (
        os.environ.get("REDIS_HOST", "localhost"),
        int(os.environ.get("REDIS_PORT", "6379")),
    )


def _ping_redis() -> bool:
    try:
        import redis  # type: ignore[import-not-found]

        host, port = _redis_url_parts()
        client = redis.Redis(host=host, port=port, socket_connect_timeout=0.5)
        return bool(client.ping())
    except Exception:
        return False


@pytest.fixture(scope="session")
def redis_available() -> bool:
    return _ping_redis()


@pytest.fixture
def require_redis(redis_available: bool) -> None:
    if not redis_available:
        pytest.skip("redis not reachable for realtime test")


@pytest.fixture
async def aredis():
    """Async client + automatic cleanup of all ``rt:*`` keys the test
    might have left behind."""
    import redis.asyncio as aioredis

    host, port = _redis_url_parts()
    client = aioredis.Redis(host=host, port=port, decode_responses=True)
    try:
        yield client
    finally:
        try:
            cursor = 0
            while True:
                cursor, keys = await client.scan(cursor=cursor, match="rt:*", count=200)
                if keys:
                    await client.delete(*keys)
                if cursor == 0:
                    break
        finally:
            await client.aclose()
