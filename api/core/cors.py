"""CORS for the admin API.

The admin pages are static files on Cloudflare Pages and call the API on
another host of the same domain, with cookies. Only SITE_ORIGIN, exactly, may
read admin responses; public routes send no CORS headers, as the site reads
them at build time and shows images with plain tags.

The site's pages call a few public routes from the browser: the contact
form, and the CV's status, view link, file and copy request. They get their
own, narrower rule: the site origin only, no credentials (they send no
cookie), and for the forms POST and Content-Type only with a short cache for
the preflight. The CV status and file are plain GETs, which need no
preflight. Nothing else public is opened up.

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
# Public routes the site's pages POST to, and public routes they GET.
FORM_PATHS = {CONTACT_PATH, "/api/v1/cv/link", "/api/v1/cv/request"}
READ_PATHS = {"/api/v1/cv"}
CV_FILE_PREFIX = "/api/v1/cv/file/"
CONTACT_METHODS = ("POST",)
CONTACT_HEADERS = ("content-type",)
CONTACT_MAX_AGE = "120"
# Retry-After is not one a page may read unless it is listed here, and the form
# uses it to say how long to wait.
CONTACT_EXPOSED = "Retry-After"


def _admin(path):
    return path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")


def _contact(path):
    return path in FORM_PATHS


def _site_read(path):
    if path in READ_PATHS:
        return True
    token = path.removeprefix(CV_FILE_PREFIX)
    return path.startswith(CV_FILE_PREFIX) and bool(token) and "/" not in token


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
        elif _contact(request.path) or _site_read(request.path):
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
