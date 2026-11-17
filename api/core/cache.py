from functools import lru_cache

import redis
from django.conf import settings


@lru_cache(maxsize=4)
def _connect(url):
    return redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)


def client():
    """Redis connection. Raises when Redis is not configured, so callers fail closed."""
    if not settings.REDIS_URL:
        raise redis.ConnectionError("REDIS_URL is not set")
    return _connect(settings.REDIS_URL)
