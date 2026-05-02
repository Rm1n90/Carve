# Armin Mehri — mehri.armin@gmail.com
"""Rate limiter shared across routers (slowapi)."""
from slowapi import Limiter
from slowapi.util import get_remote_address

# Memory backend is fine for a single API container; switch to Redis later if scaled.
limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
