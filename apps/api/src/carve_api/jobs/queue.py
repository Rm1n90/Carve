from redis import Redis
from rq import Queue

from carve_api.config import get_settings


def get_queue() -> Queue:
    s = get_settings()
    return Queue("default", connection=Redis(host=s.redis_host, port=s.redis_port))
