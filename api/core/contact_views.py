"""The public contact form route. It takes no cookie or session, so it needs
no CSRF token; the request guard still requires the site's own Origin on the
POST. The CV copy request (core.cv_views) goes through the same steps."""

import json
import logging
from contextlib import suppress

from django.conf import settings
from django.utils.module_loading import import_string
from django.views.decorators.csrf import csrf_exempt

from core import blocklist, contact, ratelimit, responses, turnstile
from core import limits as contact_limits
from core.guard import UNAVAILABLE
from core.models import ContactMessage

log = logging.getLogger(__name__)

FIELDS = {"name", "email", "reason", "body", "website", "elapsed", "turnstile"}
# A message at its longest is about 5 kB of JSON.
MAX_BODY_BYTES = 20_000


def _logged(outcome, message=None):
    if message is None:
        log.info("contact outcome=%s", outcome)
    else:
        log.info("contact id=%s outcome=%s", message.id, outcome)


@csrf_exempt
def submit(request):
    if request.method != "POST":
        return responses.method_not_allowed(("POST",))
    data, refusal = read_json(request)
    if refusal:
        return refusal
    values, errors = contact.clean(data)
    if errors:
        _logged("invalid")
        return responses.invalid(errors)
    try:
        return accept(data, values, ratelimit.client_address(request))
    except contact.Limited as limit:
        _logged("rate_limited")
        return responses.contact_limited(limit.seconds)
    except (*UNAVAILABLE, turnstile.Unavailable) as error:
        return unavailable(error)


def read_json(request, fields=FIELDS):
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
    if not isinstance(data, dict) or set(data) - fields:
        return None, responses.bad_request()
    return data, None


def passes_turnstile(token):
    """True if Turnstile says this token is good. Raises Unavailable if it could
    not be asked."""
    if not isinstance(token, str) or not 0 < len(token) <= turnstile.TOKEN_MAX:
        return False
    return bool(import_string(settings.TURNSTILE_VERIFIER)().verify(token))


def accept(data, values, address, kind=ContactMessage.Kind.MESSAGE, repeat=None):
    """Every check and limit, then store. repeat is the text whose repeat
    within a day counts as spam; the body unless given."""
    limits = contact_limits.effective()
    contact.count_attempt(address, limits)
    if not passes_turnstile(data.get("turnstile")):
        _logged("bad_challenge")
        return responses.bad_challenge()
    # Before any cap is counted, so a blocked sender uses none of them, and
    # answered like dropped spam, so they cannot tell they are blocked. If the
    # check itself fails the error reaches the handler: 503, nothing stored.
    if blocklist.hit(values["email"]):
        _logged("blocked_dropped")
        return responses.contact_sent()
    contact.count_email(values["email"], limits)
    seconds = contact.seconds_open(data.get("elapsed"))
    repeat = values["body"] if repeat is None else repeat
    repeated = not contact.claim_body(repeat)
    # From here on, a message that is not stored gives its body's marker back,
    # so sending it again later is not taken for a repeat.
    try:
        score, outcome = contact.spam_score(
            values, data.get("website", ""), seconds, repeated, limits
        )
        spam = outcome is not None
        if not contact.count_daily(spam, limits):
            _release(repeat, repeated)
            _logged("spam_dropped")
            return responses.contact_sent()
        message = contact.store(values, address, score, spam=spam, kind=kind)
    except Exception:
        _release(repeat, repeated)
        raise
    _logged(outcome or "stored", message)
    return responses.contact_sent()


def _release(text, repeated):
    # A repeat's marker belongs to the message stored earlier, so it stays.
    if not repeated:
        with suppress(*UNAVAILABLE):
            contact.release_body(text)


def unavailable(error):
    log.error("contact unavailable: %s", type(error).__name__)
    return responses.unavailable()
