"""Notices to the owner. Notifiers are pluggable: settings.NOTIFIERS lists dotted
paths of classes with send(event, context).

Context must never hold secrets, session tokens or addresses.

A notifier marked in_band only keeps the notice inside the site (the database
notifier, whose alerts the owner reads in the admin). It is best effort: if it
fails, that is logged and counted and the notice still goes to the others. It
never counts as telling the owner, since whoever holds the admin could read
and dismiss it: a required notice needs at least one notifier that is not in
band.
"""

import json
import logging
import re
from datetime import UTC
from http.client import HTTPException
from urllib.request import HTTPRedirectHandler, Request, build_opener

from django.conf import settings
from django.utils import timezone
from django.utils.module_loading import import_string

from core import abuse, alerts

log = logging.getLogger(__name__)


class Undelivered(Exception):
    """A notice the owner must get could not be sent."""


def _notifiers():
    return [import_string(path)() for path in settings.NOTIFIERS]


def _in_band(notifier):
    return getattr(notifier, "in_band", False)


def send(event, **context):
    """Tell every configured notifier. Raises if one that is not in band
    fails."""
    for notifier in _notifiers():
        if not _in_band(notifier):
            notifier.send(event, context)
            continue
        try:
            notifier.send(event, context)
        except Exception as error:
            log.warning("notice %s not recorded: %s", event, type(error).__name__)
            abuse.count(abuse.NOTICE_FAILED)


def send_required(event, **context):
    """For notices an action depends on: no notifier outside the site, or a
    failed one, raises."""
    if not any(not _in_band(notifier) for notifier in _notifiers()):
        raise Undelivered("no notifier is configured")
    try:
        send(event, **context)
    except Exception as error:
        raise Undelivered(type(error).__name__) from error


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


class ResendNotifier:
    """Sends the notice as a plain text email through Resend. The settings come
    from the environment; with any of them missing it raises, so a required
    notice is refused. No retries: a failure raises at once. Only the event
    and the error type are ever logged."""

    def send(self, event, context):
        text = email_text(event, context)
        if text is None:
            return
        key = settings.RESEND_API_KEY
        sender, to = settings.NOTICE_EMAIL_FROM, settings.NOTICE_EMAIL_TO
        if not (key and sender and to):
            log.warning("notice email %s not sent: not configured", event)
            raise EmailFailed("email notifier is not configured")
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
