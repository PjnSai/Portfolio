"""The one place admin authorisation is decided.

Every view under /api/v1/admin/ must be wrapped with admin_route. The request
guard refuses any admin view that is not, so a new route is denied by default.
"""

import enum
import json
from functools import wraps

from core import responses, sessions

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class Level(enum.Enum):
    ACCESS = "access"  # Cloudflare Access only: the sign-in routes.
    SESSION = "session"  # Signed in with a passkey.
    ELEVATED = "elevated"  # Passkey confirmed again in the last few minutes.


def admin_route(level, methods=("GET",)):
    def decorate(view):
        @wraps(view)
        def guarded(request, *args, **kwargs):
            if not getattr(request, "access_verified", False):
                return responses.forbidden()
            if request.method not in methods:
                return responses.method_not_allowed(methods)
            unsafe = request.method not in SAFE_METHODS
            if level is not Level.ACCESS:
                session = sessions.current(request)
                if session is None:
                    return responses.not_signed_in()
                if level is Level.ELEVATED and not sessions.is_elevated(session):
                    return responses.elevation_required()
                request.admin_session = session
            if unsafe:
                request.json = _json_object(request)
                if request.json is None:
                    return responses.bad_request()
            return view(request, *args, **kwargs)

        guarded.admin_level = level
        guarded.admin_methods = list(methods)
        return guarded

    return decorate


def _json_object(request):
    if not request.body:
        return {}
    try:
        body = json.loads(request.body)
    except ValueError:
        return None
    return body if isinstance(body, dict) else None
