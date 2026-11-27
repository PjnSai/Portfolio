"""Notices to the owner. Notifiers are pluggable: settings.NOTIFIERS lists dotted
paths of classes with send(event, context).

Context must never hold secrets, session tokens or addresses.

A notifier marked in_band only keeps the notice inside the site (the database
notifier, whose alerts the owner reads in the admin). It is best effort: if it
fails, that is logged and counted and the notice still goes to the others. It
never counts as telling the owner, since whoever holds the admin could read
and dismiss it: a required notice needs at least one notifier that is not in
band.

Every notifier is told even if an earlier one fails, so the order in
settings.NOTIFIERS does not matter for that. The first failure of a notifier
that is not in band is raised afterwards.
"""

import json
import logging
import re
from contextvars import ContextVar
from datetime import UTC
from http.client import HTTPException
from urllib.request import HTTPRedirectHandler, Request, build_opener

from django.conf import settings
from django.utils import timezone
from django.utils.module_loading import import_string

from core import abuse, alerts, ratelimit

log = logging.getLogger(__name__)

_required = ContextVar("notice_required", default=False)


class Undelivered(Exception):
    """A notice the owner must get could not be sent."""


def _notifiers():
    return [import_string(path)() for path in settings.NOTIFIERS]


def _in_band(notifier):
    return getattr(notifier, "in_band", False)


def send(event, **context):
    """Tell every configured notifier, in order, whether or not an earlier one
    failed, so a broken email can never keep the log or the admin alert from
    recording the notice. Once all have been told, raises the first failure of
    one that is not in band."""
    failure = None
    for notifier in _notifiers():
        try:
            notifier.send(event, context)
        except Exception as error:
            if _in_band(notifier):
                log.warning("notice %s not recorded: %s", event, type(error).__name__)
                abuse.count(abuse.NOTICE_FAILED)
            else:
                log.warning(
                    "notice %s not sent by %s: %s",
                    event,
                    type(notifier).__name__,
                    type(error).__name__,
                )
                if failure is None:
                    failure = error
    if failure is not None:
        raise failure


def send_required(event, **context):
    """For notices an action depends on: no notifier outside the site, or a
    failed one, raises."""
    if not any(not _in_band(notifier) for notifier in _notifiers()):
        raise Undelivered("no notifier is configured")
    token = _required.set(True)
    try:
        send(event, **context)
    except Exception as error:
        raise Undelivered(type(error).__name__) from error
    finally:
        _required.reset(token)


def required():
    """Whether the notice being sent now came through send_required."""
    return _required.get()


def send_if_possible(event, **context):
    """For notices about an action that must go ahead whether or not they arrive."""
    try:
        send(event, **context)
    except Exception:
        log.exception("notice %s could not be sent", event)


class DatabaseNotifier:
    """Records the notice as an alert the owner sees in the admin, if it is
    one (core.alerts)."""

    in_band = True

    def send(self, event, context):
        alerts.record(event, context)


class LogNotifier:
    """Writes the notice to the application log, where an alert can pick it up."""

    def send(self, event, context):
        log.warning("notice %s %s", event, json.dumps(context, sort_keys=True))


EMAIL_URL = "https://api.resend.com/emails"
EMAIL_TIMEOUT = 5


class EmailFailed(Exception):
    """An email notice was not accepted. The message is never more than an
    error type or a status, so it cannot carry the key or a header."""


class _NoRedirect(HTTPRedirectHandler):
    # A redirect is answered as an error, so the key is never sent on to
    # another address.
    def redirect_request(self, *args, **kwargs):
        return None


_opener = build_opener(_NoRedirect)


def urlopen(request, timeout):
    return _opener.open(request, timeout=timeout)


# Passkey names are the owner's own short labels. Anything else (an address,
# message text, anything with a run of characters as long as a key or token)
# is left out of an email.
PASSKEY_NAME = re.compile(r"[A-Za-z0-9 .'()-]{1,40}")
PASSKEY_WORD = 20


def _passkey(context):
    name = context.get("name")
    if (
        isinstance(name, str)
        and PASSKEY_NAME.fullmatch(name)
        and all(len(word) <= PASSKEY_WORD for word in name.split())
    ):
        return f'"{name}"'
    return "(name not shown)"


def _count(context, name):
    return alerts._number(context, name)


def _vital_requested(context):
    what = alerts.VITAL_KINDS.get(context.get("kind"), "a change")
    return (
        f"A vital action was requested: {what}. It runs after the 24 hour "
        "wait unless it is cancelled. If it was not you, cancel it in the admin."
    )


def _passkey_added(context):
    how = alerts.VIA.get(context.get("via"))
    if "name" in context:
        added = f"A passkey {_passkey(context)} was added"
    else:
        added = "A passkey was added"
    return f"{added} {how}." if how else f"{added}."


def _alert(event):
    return lambda context: alerts.summary(event, context)


# Keyed by name rather than by the alerts constants: core.alerts imports
# this module.
EMAIL_TEXT = {
    "vital_action_requested": ("Vital action requested", _vital_requested),
    "passkey_added": ("Passkey added", _passkey_added),
    "passkey_revoked": (
        "Passkey removed",
        lambda c: f"The passkey {_passkey(c)} was removed through a vital action.",
    ),
    "recovery_used": (
        "Recovery key used",
        lambda c: f"{alerts.summary('recovery_used', c)} New passkey: {_passkey(c)}.",
    ),
    "lockout": ("Sign-in paused", _alert("lockout")),
    "failed_sign_ins": ("Failed sign-ins", _alert("failed_sign_ins")),
    "rate_limit_storm": ("Many requests refused", _alert("rate_limit_storm")),
    "error_spike": ("Server errors", _alert("error_spike")),
    "sessions_revoked": (
        "Sessions ended",
        lambda c: f"Every admin session was ended ({_count(c, 'count')} in all).",
    ),
    "access_revoked": (
        "Access reset",
        lambda c: (
            f"All access was reset: {_count(c, 'passkeys')} passkeys removed, "
            f"{_count(c, 'sessions')} sessions ended, "
            f"{_count(c, 'pending_actions')} pending actions cancelled."
        ),
    ),
}


def email_text(event, context, now=None):
    """(subject, body) for an event that is emailed, else None. Plain text with
    no links, built only from fixed words, numbers, values from fixed lists and
    a passkey name that passes PASSKEY_NAME."""
    if event not in EMAIL_TEXT:
        return None
    title, line = EMAIL_TEXT[event]
    when = (now or timezone.now()).astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    body = (
        f"{line(context)}\n\n"
        f"Event: {event}\n"
        f"Time: {when}\n\n"
        "Sent by the portfolio admin. The admin has the details.\n"
    )
    return f"Portfolio: {title}", body


def _within_budget(now=None):
    """Take one email from today's budget for notices that are not required.
    False when it is spent or the counter cannot be read."""
    day = (now or timezone.now()).astimezone(UTC).date().isoformat()
    try:
        count = ratelimit.hit(f"notice-email:{day}", 2 * 24 * 60 * 60)
    except Exception as error:
        log.warning("notice email budget unreadable: %s", type(error).__name__)
        return False
    return count <= settings.NOTICE_EMAIL_DAILY_BUDGET


class ResendNotifier:
    """Sends the notice as a plain text email through Resend. The settings come
    from the environment; with any of them missing it raises, so a required
    notice is refused. No retries: a failure raises at once. Only the event
    and the error type are ever logged.

    Required notices are always sent. Others share a daily budget; past it, or
    with the counter unreadable, the email is skipped and counted, and the
    other notifiers still record the notice."""

    def send(self, event, context):
        text = email_text(event, context)
        if text is None:
            return
        key = settings.RESEND_API_KEY
        sender, to = settings.NOTICE_EMAIL_FROM, settings.NOTICE_EMAIL_TO
        if not (key and sender and to):
            log.warning("notice email %s not sent: not configured", event)
            raise EmailFailed("email notifier is not configured")
        if not required() and not _within_budget():
            log.info("notice email %s skipped: daily budget", event)
            abuse.count(abuse.NOTICE_SKIPPED)
            return
        subject, body = text
        request = Request(
            EMAIL_URL,
            data=json.dumps(
                {"from": sender, "to": [to], "subject": subject, "text": body}
            ).encode(),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "User-Agent": "portfolio-notifier",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=EMAIL_TIMEOUT) as response:
                status = response.status
        except (OSError, HTTPException, ValueError) as error:
            log.warning("notice email %s not sent: %s", event, type(error).__name__)
            raise EmailFailed(type(error).__name__) from None
        if not 200 <= status < 300:
            log.warning("notice email %s not sent: status %s", event, status)
            raise EmailFailed(f"status {status}")
