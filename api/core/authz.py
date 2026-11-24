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


def admin_route(level, methods=("GET",), form=False, elevate=()):
    """form=True: unsafe requests carry a multipart form (an upload), not JSON.
    elevate: methods that need Level.ELEVATED although the route's level is lower
    (a page anyone signed in may read but only a confirmed passkey may change)."""
    levels = {m: Level.ELEVATED if m in elevate else level for m in methods}
    if set(elevate) - set(methods) or (elevate and level is not Level.SESSION):
        raise ValueError("elevate names methods of a SESSION route")

    def decorate(view):
        @wraps(view)
        def guarded(request, *args, **kwargs):
            if not getattr(request, "access_verified", False):
                return responses.forbidden()
            if request.method not in methods:
                return responses.method_not_allowed(methods)
            unsafe = request.method not in SAFE_METHODS
            needed = levels[request.method]
            if needed is not Level.ACCESS:
                session = sessions.current(request)
                if session is None:
                    return responses.not_signed_in()
                if needed is Level.ELEVATED and not sessions.is_elevated(session):
                    return responses.elevation_required()
                request.admin_session = session
            if unsafe and form:
                request.json = None
                if request.content_type != "multipart/form-data":
                    return responses.bad_request()
            elif unsafe:
                request.json = _json_object(request)
                if request.json is None:
                    return responses.bad_request()
            return view(request, *args, **kwargs)

        guarded.admin_level = level
        guarded.admin_methods = list(methods)
        guarded.admin_levels = dict(levels)
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
