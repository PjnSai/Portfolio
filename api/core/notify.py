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

from django.conf import settings
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
