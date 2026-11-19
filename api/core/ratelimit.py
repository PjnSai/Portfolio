"""Rate limits. Counters live in Redis; cool-downs are rows in rate_limit_blocks.

Addresses are only ever handled as a keyed hash. If Redis or the database is
down these functions raise, and the request guard answers 503, except
public_cap: public reads fail static, so it lets the request through.
"""

import hashlib
import hmac
import logging
import math
import time
from datetime import timedelta

import redis
from django.conf import settings
from django.utils import timezone

from core import audit, cache, notify
from core.models import RateLimitBlock

log = logging.getLogger(__name__)

FAILURE_WINDOW = 15 * 60
COOL_DOWN = timedelta(minutes=15)


def keyed(value):
    key = settings.SECRET_KEY.encode()
    return hmac.new(key, f"rate:{value}".encode(), hashlib.sha256).hexdigest()


def client_key(request):
    # Admin requests reach this point only with a valid Cloudflare Access token,
    # so Cloudflare's client address header can be used here. For public reads
    # it is trusted only as far as the edge is: the edge limit comes first.
    address = request.headers.get("Cf-Connecting-Ip") or request.META.get(
        "REMOTE_ADDR", ""
    )
    return keyed(f"ip:{address}")


def _increment(name, seconds):
    # The key is created with its expiry first, so a counter can never outlive
    # its window.
    client = cache.client()
    client.set(name, 0, ex=seconds, nx=True)
    return client.incr(name)


def request_cap(request):
    """Seconds to wait if this client is over the per-minute cap, else None."""
    now = time.time()
    count = _increment(f"requests:{client_key(request)}:{int(now // 60)}", 60)
    if count > settings.ADMIN_REQUESTS_PER_MINUTE:
        return 60 - int(now % 60)
    return None


def public_cap(request):
    """Seconds to wait if this client is over the public per-minute cap, else
    None. With Redis down there is no count, and the read goes ahead."""
    now = time.time()
    try:
        count = _increment(f"public:{client_key(request)}:{int(now // 60)}", 60)
    except redis.RedisError as error:
        log.warning("public rate limit skipped: %s", type(error).__name__)
        return None
    if count > settings.PUBLIC_REQUESTS_PER_MINUTE:
        return 60 - int(now % 60)
    return None


def _remaining(key_hashes):
    now = timezone.now()
    block = (
        RateLimitBlock.objects.filter(key_hash__in=key_hashes, expires_at__gt=now)
        .order_by("-expires_at")
        .first()
    )
    if block is None:
        return None
    return math.ceil((block.expires_at - now).total_seconds())


def cool_down(request):
    """Seconds left of any sign-in cool-down, this client's or the global one."""
    return _remaining([client_key(request), keyed("global")])


def client_cool_down(request):
    """Seconds left of this client's own sign-in cool-down, else None."""
    return _remaining([client_key(request)])


def global_cool_down():
    """Seconds left of the global cool-down, else None.

    Failures from many addresses start it. It closes bootstrap and turns every
    failed sign-in into a 429, but a sign-in with a valid passkey still goes
    through, so a flood of failures cannot lock the owner out.
    """
    return _remaining([keyed("global")])


def sign_in_failed(request):
    limits = (
        (client_key(request), settings.LOGIN_MAX_FAILURES, "login"),
        (keyed("global"), settings.LOGIN_GLOBAL_MAX_FAILURES, "login-global"),
    )
    for key_hash, limit, scope in limits:
        name = f"failures:{key_hash}"
        if _increment(name, FAILURE_WINDOW) >= limit:
            cache.client().delete(name)
            _block(key_hash, scope)


def sign_in_succeeded(request):
    cache.client().delete(f"failures:{client_key(request)}")


def _block(key_hash, scope):
    now = timezone.now()
    RateLimitBlock.objects.filter(expires_at__lte=now).delete()
    RateLimitBlock.objects.update_or_create(
        key_hash=key_hash,
        defaults={"scope": scope, "created_at": now, "expires_at": now + COOL_DOWN},
    )
    audit.record("lockout", actor="system", scope=scope)
    try:
        notify.send("lockout", scope=scope)
    except Exception:
        # The cool-down stands whether or not the owner could be told.
        log.exception("lockout notification failed")
