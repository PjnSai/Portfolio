"""The public contact form routes. Neither takes a cookie or a session, so
neither needs a CSRF token; the request guard still requires the site's own
Origin on the POST."""

import json
import logging

from django.conf import settings
from django.http import JsonResponse
from django.utils.module_loading import import_string
from django.views.decorators.csrf import csrf_exempt

from core import contact, ratelimit, responses, turnstile
from core.guard import UNAVAILABLE

log = logging.getLogger(__name__)

FIELDS = {"name", "email", "reason", "body", "website", "started", "turnstile"}
# A message at its longest is about 5 kB of JSON.
MAX_BODY_BYTES = 20_000


def _logged(outcome, message=None):
    if message is None:
        log.info("contact outcome=%s", outcome)
    else:
        log.info("contact id=%s outcome=%s", message.id, outcome)


@csrf_exempt
def start(request):
    if request.method != "GET":
        return responses.method_not_allowed(("GET",))
    try:
        contact.count_start(ratelimit.client_address(request))
    except contact.Limited as limit:
        _logged("rate_limited")
        return responses.too_many_requests(limit.seconds)
    except UNAVAILABLE as error:
        return _unavailable(error)
    return JsonResponse(contact.start(), headers={"Cache-Control": "no-store"})


@csrf_exempt
def submit(request):
    if request.method != "POST":
        return responses.method_not_allowed(("POST",))
    data, refusal = _read(request)
    if refusal:
        return refusal
    values, errors = contact.clean(data)
    if errors:
        _logged("invalid")
        return responses.invalid(errors)
    try:
        return _accept(data, values, ratelimit.client_address(request))
    except contact.Limited as limit:
        _logged("rate_limited")
        return responses.contact_limited(limit.seconds)
    except (*UNAVAILABLE, turnstile.Unavailable) as error:
        return _unavailable(error)


def _read(request):
    """(the JSON object sent, None), or (None, the refusal to send)."""
    length = request.META.get("CONTENT_LENGTH") or "0"
    if not length.isdigit() or int(length) > MAX_BODY_BYTES:
        return None, responses.too_large()
    if request.content_type != "application/json":
        return None, responses.bad_request()
    try:
        data = json.loads(request.body)
    except ValueError:
        return None, responses.bad_request()
    if not isinstance(data, dict) or set(data) - FIELDS:
        return None, responses.bad_request()
    return data, None


def _checked(token):
    """True if Turnstile says this token is good. Raises Unavailable if it could
    not be asked."""
    if not isinstance(token, str) or not 0 < len(token) <= turnstile.TOKEN_MAX:
        return False
    return bool(import_string(settings.TURNSTILE_VERIFIER)().verify(token))


def _accept(data, values, address):
    contact.count_attempt(address)
    seconds = contact.seconds_open(data.get("started"))
    # A bad form token is refused before Cloudflare is asked.
    if seconds is None or not _checked(data.get("turnstile")):
        _logged("bad_challenge")
        return responses.bad_challenge()
    contact.count_sender(values["email"])
    score, outcome = contact.spam_score(values, data.get("website", ""), seconds)
    message = contact.store(values, address, score, spam=outcome is not None)
    _logged(outcome or "stored", message)
    return responses.contact_sent()


def _unavailable(error):
    log.error("contact unavailable: %s", type(error).__name__)
    return responses.unavailable()
