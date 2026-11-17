"""Server-side sessions. The cookie holds a random token; the table its hash."""

import base64
import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from core.models import Owner, Session

COOKIE = "__Host-session"
IDLE = timedelta(minutes=15)
ABSOLUTE = timedelta(hours=8)
ELEVATION = timedelta(minutes=5)


def _hash(token):
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def clear_cookie(response):
    response.delete_cookie(COOKIE, path="/", samesite="Strict")


def start(response, authenticated_at=None, elevated_until=None):
    """Create a session with a fresh 256-bit token. Never reuses a supplied one."""
    token = secrets.token_urlsafe(32)
    session = Session.objects.create(
        owner=Owner.objects.get(),
        token_hash=_hash(token),
        authenticated_at=authenticated_at or timezone.now(),
        elevated_until=elevated_until,
    )
    # No Max-Age or Expires: the cookie goes when the browser closes.
    response.set_cookie(
        COOKIE, token, secure=True, httponly=True, samesite="Strict", path="/"
    )
    return session


def current(request):
    """The live session for this request, or None. Marks it as just seen."""
    token = request.COOKIES.get(COOKIE)
    if not token:
        return None
    session = Session.objects.filter(
        token_hash=_hash(token), revoked_at=None, owner__singleton=True
    ).first()
    if session is None:
        return None
    now = timezone.now()
    idle = now - session.last_seen_at > IDLE
    too_old = now - session.authenticated_at > ABSOLUTE
    if idle or too_old:
        revoke(session)
        return None
    session.last_seen_at = now
    session.save(update_fields=["last_seen_at"])
    return session


def revoke(session):
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at"])


def retire_presented(request):
    """End whatever session the browser sent, before a new one is issued."""
    token = request.COOKIES.get(COOKIE)
    if token:
        Session.objects.filter(token_hash=_hash(token), revoked_at=None).update(
            revoked_at=timezone.now()
        )


def rotate(response, session, elevated_until=None):
    """New token on a privilege change. The absolute timeout keeps running."""
    revoke(session)
    return start(
        response,
        authenticated_at=session.authenticated_at,
        elevated_until=elevated_until,
    )


def revoke_all():
    return Session.objects.filter(revoked_at=None).update(revoked_at=timezone.now())


def is_elevated(session):
    return bool(session.elevated_until and session.elevated_until > timezone.now())


def csrf_token(session):
    """Derived from the session, so it changes whenever the session rotates."""
    key = settings.SECRET_KEY.encode()
    digest = hmac.new(key, f"csrf:{session.token_hash}".encode(), hashlib.sha256)
    return base64.urlsafe_b64encode(digest.digest()).rstrip(b"=").decode()


def csrf_ok(session, supplied):
    if not supplied:
        return False
    expected = csrf_token(session).encode()
    return hmac.compare_digest(supplied.encode("utf-8", "replace"), expected)
