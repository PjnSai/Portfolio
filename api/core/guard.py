"""Request guard. Runs before any view.

1. State-changing requests must come from this site: exact Origin match and
   Sec-Fetch-Site: same-origin.
2. Everything under /api/v1/admin/ needs a valid Cloudflare Access token, checked
   on every request and before the URL is resolved, so unknown paths look the
   same as known ones.
3. Admin requests are capped per client per minute.
4. If the database or Redis is down, admin requests get a plain 503. This
   applies under /api/v1/admin/ only: the guard uses neither for a public
   request, so public routes keep answering.
"""

import logging

import redis
from django.conf import settings
from django.db import DatabaseError, InterfaceError

from core import access, ratelimit, responses
from core.authz import SAFE_METHODS

log = logging.getLogger(__name__)

ADMIN_PREFIX = "/api/v1/admin"
UNAVAILABLE = (DatabaseError, InterfaceError, redis.RedisError)


def _is_admin(path):
    return path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")


def _same_origin(request, admin):
    site = request.headers.get("Sec-Fetch-Site")
    if request.method in SAFE_METHODS:
        # Browsers that send the header must say same-origin for admin reads.
        return not admin or site in (None, "same-origin")
    origin = settings.SITE_ORIGIN
    if not origin or site != "same-origin":
        return False
    return request.headers.get("Origin") == origin


class GuardMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            refusal = self._check(request)
        except UNAVAILABLE as error:
            return self._unavailable(error)
        return refusal or self.get_response(request)

    def _check(self, request):
        admin = _is_admin(request.path)
        if not _same_origin(request, admin):
            return responses.forbidden()
        if not admin:
            return None
        if not access.is_valid(request.headers.get(access.HEADER)):
            return responses.forbidden()
        request.access_verified = True
        wait = ratelimit.request_cap(request)
        if wait:
            return responses.too_many_requests(wait)
        return None

    def process_view(self, request, view, args, kwargs):
        # Deny by default: an admin URL without a declared level is refused,
        # and a view with a level is refused if the guard did not vet it.
        declared = hasattr(view, "admin_level")
        vetted = getattr(request, "access_verified", False)
        if _is_admin(request.path) != declared or (declared and not vetted):
            return responses.forbidden()
        return None

    def process_exception(self, request, exception):
        # Admin only. Public routes are not turned into a 503 here.
        if _is_admin(request.path) and isinstance(exception, UNAVAILABLE):
            return self._unavailable(exception)
        return None

    def _unavailable(self, error):
        log.error("dependency unavailable: %s", type(error).__name__)
        return responses.unavailable()
