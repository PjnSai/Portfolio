"""How long contact messages are kept (SPEC 5.8a, 6.2).

Spam goes after 30 days by default, other messages after 12 months. A message
the owner marked kept, or has written notes on, is never removed by the daily
job (Phase 4B); only the owner deletes it. Both periods are set by the owner in
the admin and stored on the settings row, apart from the draft and published
copies, so they never reach the public site.

expires_at on each message says when the job may remove it. It is set when the
message arrives, moved when the message changes between spam and not spam, and
all of them are moved when the owner changes a period. The spam period runs
from spam_at, so an old message marked spam today still has the full period.
"""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.db.models.functions import Coalesce

from core import audit, content
from core.models import ContactMessage, SiteSettings

MIN_DAYS = 7
MAX_DAYS = 3650
Status = ContactMessage.Status


def periods():
    """(spam days, other days). The defaults until the owner has saved settings;
    reading them never creates a settings row."""
    row = SiteSettings.objects.values_list(
        "retention_spam_days", "retention_message_days"
    ).first()
    return row or (settings.RETENTION_SPAM_DAYS, settings.RETENTION_MESSAGE_DAYS)


def apply(message):
    """Set one message's expiry from its status and the current periods. Spam
    is counted from when it became spam, anything else from when it arrived."""
    spam_days, message_days = periods()
    if message.status == Status.SPAM:
        start = message.spam_at or message.created_at
        message.expires_at = start + timedelta(days=spam_days)
    else:
        message.expires_at = message.created_at + timedelta(days=message_days)


def reapply_all():
    """After the owner changes a period, move every message's expiry."""
    spam_days, message_days = periods()
    ContactMessage.objects.filter(status=Status.SPAM).update(
        expires_at=Coalesce(F("spam_at"), F("created_at")) + timedelta(days=spam_days)
    )
    ContactMessage.objects.exclude(status=Status.SPAM).update(
        expires_at=F("created_at") + timedelta(days=message_days)
    )


def save(spam_days, message_days):
    """Set both periods, move every message's expiry and record it."""
    with transaction.atomic():
        row = content.site_settings()
        row.retention_spam_days = spam_days
        row.retention_message_days = message_days
        row.save(update_fields=["retention_spam_days", "retention_message_days"])
        reapply_all()
        audit.record(
            "retention_changed", spam_days=spam_days, message_days=message_days
        )
