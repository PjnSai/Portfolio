"""Alerts to the owner (SPEC 10.15): repeated failed sign-ins or passkey
confirmations, a new passkey, a vital action requested, a storm of rate-limit
refusals and a spike of server errors.

The first two of the threshold kinds are counted from the abuse counters
(core.abuse.count calls observe), server errors by ServerErrorMiddleware. Each
is a Redis counter for a fixed window; reaching the threshold sends one notice
through core.notify, and the database notifier records it here. The others
are notices the code sends already.

An alert never repeats a threshold kind inside its window, and no kind gets
more than ALERT_DAILY_CAP alerts a UTC day, so alerts cannot flood. The
summary is fixed text with counts and kinds only.

All of this is best effort: nothing here raises into the request or action
that caused it. A failure is logged with its kind and no detail.
"""

import logging
import time
from datetime import UTC, datetime, timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import notify, ratelimit
from core.models import Alert

log = logging.getLogger(__name__)

FAILED_SIGN_INS = "failed_sign_ins"
PASSKEY_ADDED = "passkey_added"
VITAL_ACTION_REQUESTED = "vital_action_requested"
RATE_LIMIT_STORM = "rate_limit_storm"
ERROR_SPIKE = "error_spike"
KINDS = (
    FAILED_SIGN_INS,
    PASSKEY_ADDED,
    VITAL_ACTION_REQUESTED,
    RATE_LIMIT_STORM,
    ERROR_SPIKE,
)

# Threshold kinds: the names of their threshold and window settings.
RULES = {
    FAILED_SIGN_INS: ("ALERT_SIGN_IN_FAILURES", "ALERT_SIGN_IN_WINDOW"),
    RATE_LIMIT_STORM: ("ALERT_RATE_LIMITED", "ALERT_RATE_LIMITED_WINDOW"),
    ERROR_SPIKE: ("ALERT_SERVER_ERRORS", "ALERT_SERVER_ERRORS_WINDOW"),
}

# Abuse counter kinds (core.abuse) that feed a threshold kind.
WATCHED = {
    "login_failed": FAILED_SIGN_INS,
    "elevation_failed": FAILED_SIGN_INS,
    "rate_limited": RATE_LIMIT_STORM,
}

# Notice events (core.notify) that are alerts, and the kind each is shown as.
EVENTS = {
    FAILED_SIGN_INS: FAILED_SIGN_INS,
    "lockout": FAILED_SIGN_INS,
    RATE_LIMIT_STORM: RATE_LIMIT_STORM,
    ERROR_SPIKE: ERROR_SPIKE,
    PASSKEY_ADDED: PASSKEY_ADDED,
    "recovery_used": PASSKEY_ADDED,
    VITAL_ACTION_REQUESTED: VITAL_ACTION_REQUESTED,
}

VITAL_KINDS = {
    "add_passkey": "add a passkey",
    "revoke_passkey": "remove a passkey",
    "permanent_delete": "delete something for good",
    "erase_sender": "delete everything about one email address",
    "cv_switches": "change the CV switches",
}
VIA = {
    "bootstrap": "as the first passkey",
    "vital_action": "through a vital action",
}


def rule(kind):
    """(threshold, window in seconds) for a threshold kind."""
    threshold, window = RULES[kind]
    return getattr(settings, threshold), getattr(settings, window)


def _number(context, name):
    value = context.get(name)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def summary(event, context):
    """Fixed text for a notice. Only numbers and values from fixed lists are
    taken from the context; names, ids and anything else in it are left out."""
    if event in RULES:
        n, minutes = _number(context, "count"), _number(context, "minutes")
        what = {
            FAILED_SIGN_INS: "failed sign-ins or passkey confirmations",
            RATE_LIMIT_STORM: "requests refused by a rate limit",
            ERROR_SPIKE: "server errors",
        }[event]
        return f"{n} {what} in {minutes} minutes."
    if event == "lockout":
        if context.get("scope") == "login-global":
            return "Sign-in was paused for everyone after repeated failures."
        return "Sign-in was paused for one client after repeated failures."
    if event == PASSKEY_ADDED:
        how = VIA.get(context.get("via"))
        return f"A passkey was added {how}." if how else "A passkey was added."
    if event == "recovery_used":
        return (
            "The recovery key was used. A new passkey was added and every "
            "other passkey and session was removed."
        )
    if event == VITAL_ACTION_REQUESTED:
        what = VITAL_KINDS.get(context.get("kind"), "a change")
        return f"A vital action was requested: {what}. Cancel it if it was not you."
    return ""


def _today_start(now):
    day = now.astimezone(UTC).date()
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def quiet(kind, now=None):
    """Why an alert of this kind would not be raised now ("repeat" or "cap"),
    or None if it would."""
    now = now or timezone.now()
    alerts = Alert.objects.filter(kind=kind)
    if kind in RULES:
        _, window = rule(kind)
        if alerts.filter(created_at__gt=now - timedelta(seconds=window)).exists():
            return "repeat"
    if alerts.filter(created_at__gte=_today_start(now)).count() >= (
        settings.ALERT_DAILY_CAP
    ):
        return "cap"
    return None


def record(event, context):
    """Store a notice as an alert, if it is one and is not held back. Called by
    the database notifier; a failure here reaches core.notify, which logs it
    and counts it. The insert has its own savepoint, so a failure cannot break
    a transaction the notice was sent from."""
    kind = EVENTS.get(event)
    if kind is None:
        return None
    with transaction.atomic():
        held = quiet(kind)
        if held:
            log.info("alert kind=%s held=%s", kind, held)
            return None
        alert = Alert.objects.create(kind=kind, summary=summary(event, context))
    log.warning("alert kind=%s", kind)
    return alert


def observe(abuse_kind):
    """One more of an abuse counter kind. Never raises."""
    kind = WATCHED.get(abuse_kind)
    if kind is not None:
        _tick(kind)


def server_error():
    """One more server error. Never raises."""
    _tick(ERROR_SPIKE)


def _tick(kind):
    try:
        threshold, window = rule(kind)
        bucket = int(time.time() // window)
        count = ratelimit.hit(f"alert:{kind}:{bucket}", window)
    except Exception as error:
        log.warning("alert count failed kind=%s error=%s", kind, type(error).__name__)
        return
    # Exactly at the threshold, so a window raises its alert once however far
    # past it the count goes.
    if count != threshold:
        return
    try:
        held = quiet(kind)
    except Exception as error:
        # The database may be what is failing; the other notifiers still hear.
        log.warning("alert check failed kind=%s error=%s", kind, type(error).__name__)
        held = None
    if held:
        log.info("alert kind=%s held=%s", kind, held)
        return
    notify.send_if_possible(kind, count=count, minutes=window // 60)


class ServerErrorMiddleware:
    """Counts every answer of 500 or more, the guard's 503s included. Next to
    first in MIDDLEWARE (after Django's security headers, which never answer
    5xx), so it sees what every other layer answered. One Redis INCR per server
    error and nothing at all for any other answer."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if response.status_code >= 500:
            server_error()
        return response
