# Armin Mehri — mehri.armin@gmail.com
"""Pacing shared by every run and every worker, in Redis.

Each source has a minimum gap between two calls; a call takes the next
free slot atomically and waits for it, so two runs at once share the
rate instead of doubling it. A source that pushes back (429, CAPTCHA,
challenge page) is marked paused for a while, so runs on other tasks do
not try it meanwhile; a run never waits for it (see jobs._Run._drop).
"""

from __future__ import annotations

import time
from collections.abc import Callable

from redis import Redis

_SLOT = """
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local slot = math.max(now, nxt)
redis.call('SET', KEYS[1], tostring(slot + tonumber(ARGV[2])), 'EX', 3600)
return tostring(slot - now)
"""

# Pause lengths after repeated push-back within the hour.
_STRIKE_PAUSES = (1.0, 2.0, 4.0, 8.0)


class Pacer:
    def __init__(self, redis: Redis) -> None:
        self.redis = redis
        self._slot = redis.register_script(_SLOT)

    def wait_turn(self, key: str, interval: float, stop: Callable[[], bool] | None = None) -> bool:
        """Wait for ``key``'s next slot. False if ``stop`` said so first."""
        wait = float(self._slot(keys=[f"webcollect:pace:{key}"], args=[time.time(), interval]))
        end = time.monotonic() + wait
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return True
            if stop is not None and stop():
                return False
            time.sleep(min(left, 0.5))

    def ready_in(self, key: str) -> float:
        """Seconds until ``key``'s next slot, without taking it."""
        value = self.redis.get(f"webcollect:pace:{key}")
        try:
            return max(float(value) - time.time(), 0.0) if value else 0.0
        except ValueError:
            return 0.0

    def pause(self, source: str, seconds: float) -> float:
        """Pause ``source`` for every run. Returns the pause applied."""
        strikes_key = f"webcollect:strikes:{source}"
        strikes = int(self.redis.incr(strikes_key))
        self.redis.expire(strikes_key, 3600)
        factor = _STRIKE_PAUSES[min(strikes - 1, len(_STRIKE_PAUSES) - 1)]
        seconds = min(seconds * factor, 6 * 3600)
        until = time.time() + seconds
        self.redis.set(f"webcollect:pause:{source}", str(until), ex=max(int(seconds), 1))
        return seconds

    def paused_for(self, source: str) -> float:
        """Seconds left on ``source``'s pause, 0 when it may be called."""
        value = self.redis.get(f"webcollect:pause:{source}")
        if not value:
            return 0.0
        try:
            return max(float(value) - time.time(), 0.0)
        except ValueError:
            return 0.0
