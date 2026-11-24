"""CORS for the admin API.

The admin pages are static files on Cloudflare Pages and call the API on
another host of the same domain, with cookies. Only SITE_ORIGIN, exactly, may
read admin responses; public routes send no CORS headers, as the site reads
them at build time and shows images with plain tags.

The contact form's POST is the one public route the site's pages call from the
browser, so it gets its own, narrower rule: the site origin only, POST only,
Content-Type only, no credentials (the form sends no cookie), and a short
cache for the preflight. Nothing else public is opened up.

Preflights are answered here, before the guard, because they carry no
credentials. They change nothing: the request that follows is checked in full.
"""

from django.conf import settings
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers

from core import responses
from core.guard import ADMIN_PREFIX

# Only what admin routes take (admin_route methods=) and web/lib/admin/api.ts sends.
METHODS = ("GET", "POST", "PATCH")
HEADERS = ("content-type", "x-csrf-token")
MAX_AGE = "600"

CONTACT_PATH = "/api/v1/contact"
CONTACT_METHODS = ("POST",)
CONTACT_HEADERS = ("content-type",)
CONTACT_MAX_AGE = "120"
# Retry-After is not one a page may read unless it is listed here, and the form
# uses it to say how long to wait.
CONTACT_EXPOSED = "Retry-After"


def _admin(path):
    return path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")


def _contact(path):
    return path == CONTACT_PATH


def _from_site(request):
    origin = settings.SITE_ORIGIN
    return bool(origin) and request.headers.get("Origin") == origin


def _allowed_headers(request, allowed=HEADERS):
    asked = request.headers.get("Access-Control-Request-Headers", "")
    names = {name.strip().lower() for name in asked.split(",") if name.strip()}
    return names <= set(allowed)


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
        if _admin(request.path):
            # CORS headers depend on Origin, so a cache must key on it.
            patch_vary_headers(response, ("Origin",))
            if _from_site(request):
                _allow(response)
        elif _contact(request.path):
            patch_vary_headers(response, ("Origin",))
            if _from_site(request):
                response["Access-Control-Allow-Origin"] = settings.SITE_ORIGIN
                response["Access-Control-Expose-Headers"] = CONTACT_EXPOSED
        return response

    def _preflight(self, request):
        method = request.headers.get("Access-Control-Request-Method")
        if _contact(request.path):
            return self._contact_preflight(request, method)
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

    def _contact_preflight(self, request, method):
        if not (
            _from_site(request)
            and method in CONTACT_METHODS
            and _allowed_headers(request, CONTACT_HEADERS)
        ):
            return responses.forbidden()
        response = HttpResponse(status=204)
        response["Access-Control-Allow-Origin"] = settings.SITE_ORIGIN
        response["Access-Control-Allow-Methods"] = ", ".join(CONTACT_METHODS)
        response["Access-Control-Allow-Headers"] = "Content-Type"
        response["Access-Control-Max-Age"] = CONTACT_MAX_AGE
        patch_vary_headers(response, ("Origin",))
        return response
