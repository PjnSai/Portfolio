"""CORS for the admin API.

The admin pages are static files on Cloudflare Pages and call the API on
another host of the same domain, with cookies. Only SITE_ORIGIN, exactly, may
read admin responses; public routes send no CORS headers, as the site reads
them at build time and shows images with plain tags.

Preflights are answered here, before the guard, because they carry no
credentials. They change nothing: the request that follows is checked in full.
"""

from django.conf import settings
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers

from core import responses
from core.guard import ADMIN_PREFIX

METHODS = ("GET", "POST", "PATCH", "PUT", "DELETE")
HEADERS = ("content-type", "x-csrf-token")
MAX_AGE = "600"


def _admin(path):
    return path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")


def _from_site(request):
    origin = settings.SITE_ORIGIN
    return bool(origin) and request.headers.get("Origin") == origin


def _allowed_headers(request):
    asked = request.headers.get("Access-Control-Request-Headers", "")
    names = {name.strip().lower() for name in asked.split(",") if name.strip()}
    return names <= set(HEADERS)


def _allow(response):
    response["Access-Control-Allow-Origin"] = settings.SITE_ORIGIN
    response["Access-Control-Allow-Credentials"] = "true"
    patch_vary_headers(response, ("Origin",))
    return response


class CorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # No route takes OPTIONS, so anything but a good preflight is refused.
        if request.method == "OPTIONS":
            return self._preflight(request)
        response = self.get_response(request)
        if _admin(request.path) and _from_site(request):
            _allow(response)
        return response

    def _preflight(self, request):
        method = request.headers.get("Access-Control-Request-Method")
        if not (
            _admin(request.path)
            and _from_site(request)
            and method in METHODS
            and _allowed_headers(request)
        ):
            return responses.forbidden()
        response = HttpResponse(status=204)
        response["Access-Control-Allow-Methods"] = ", ".join(METHODS)
        response["Access-Control-Allow-Headers"] = ", ".join(HEADERS)
        response["Access-Control-Max-Age"] = MAX_AGE
        return _allow(response)
