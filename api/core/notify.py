"""Notices to the owner. Notifiers are pluggable: settings.NOTIFIERS lists dotted
paths of classes with send(event, context).

Context must never hold secrets, session tokens or addresses.
"""

import json
import logging

from django.conf import settings
from django.utils.module_loading import import_string

log = logging.getLogger(__name__)


class Undelivered(Exception):
    """A notice the owner must get could not be sent."""


def send(event, **context):
    """Tell every configured notifier. Raises if one of them fails."""
    for path in settings.NOTIFIERS:
        import_string(path)().send(event, context)


def send_required(event, **context):
    """For notices an action depends on: no notifier, or a failed one, raises."""
    if not settings.NOTIFIERS:
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


class LogNotifier:
    """Writes the notice to the application log, where an alert can pick it up."""

    def send(self, event, context):
        log.warning("notice %s %s", event, json.dumps(context, sort_keys=True))
