"""Senders the owner has blocked (SPEC 5.8a (d), 10.13).

Only the keyed hash of an email is stored, the same one the form counts by
(core.contact.email_hash), so the list cannot be read back as addresses. The
form answers a blocked sender exactly as it answers dropped spam, and nothing
is stored or counted. An entry blocks until expires_at; the owner may renew it,
and the daily job removes it once it has expired. Nothing here returns the hash.
"""

import calendar

from django.db import transaction
from django.utils import timezone

from core import audit, contact, retention
from core.models import BlockedSender, ContactMessage, SiteSettings

MAX_ENTRIES = 500
Status = ContactMessage.Status


class Full(Exception):
    """The list already holds MAX_ENTRIES entries that still block."""


def months_later(start, months):
    month = start.month - 1 + months
    year, month = start.year + month // 12, month % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return start.replace(year=year, month=month, day=day)


def _expiry(now):
    from core import limits

    return months_later(now, limits.effective()["blocklist_months"])


def active(now=None):
    return BlockedSender.objects.filter(expires_at__gt=now or timezone.now())


def is_blocked(email):
    return active().filter(email_hash=contact.email_hash(email)).exists()


def describe(entry):
    return {
        "id": str(entry.id),
        "note": entry.note,
        "created_at": entry.created_at.isoformat(),
        "expires_at": entry.expires_at.isoformat(),
    }


def listing():
    return {
        "entries": [describe(entry) for entry in BlockedSender.objects.all()],
        "active": active().count(),
        "max_entries": MAX_ENTRIES,
    }


def _serialise_adds():
    """Lock the settings row so two adds cannot both pass the size check."""
    from core import content

    SiteSettings.objects.select_for_update().get(id=content.site_settings().id)


def ensure(email_hash, note=""):
    """The entry for this hash, added with the normal lifetime if there is none
    that still blocks. One that is there and blocking is left as it is; one that
    has expired is renewed. Must run inside a transaction. Raises Full."""
    _serialise_adds()
    now = timezone.now()
    entry = (
        BlockedSender.objects.select_for_update().filter(email_hash=email_hash).first()
    )
    if entry is not None and entry.expires_at > now:
        return entry, False
    if active(now).count() >= MAX_ENTRIES:
        raise Full
    if entry is not None:
        entry.expires_at = _expiry(now)
        entry.note = note or entry.note
        entry.save(update_fields=["expires_at", "note"])
        audit.record("sender_block_renewed", id=str(entry.id))
        return entry, False
    entry = BlockedSender.objects.create(
        email_hash=email_hash, note=note, created_at=now, expires_at=_expiry(now)
    )
    audit.record("sender_blocked", id=str(entry.id))
    return entry, True


def block_email(email, note=""):
    with transaction.atomic():
        return ensure(contact.email_hash(email), note)


def block_message(message_id, note=""):
    """Block the message's sender and move the message to spam. None if there
    is no such message."""
    with transaction.atomic():
        message = ContactMessage.objects.select_for_update().filter(id=message_id)
        message = message.first()
        if message is None:
            return None, None
        entry, created = ensure(contact.email_hash(message.email), note)
        if message.status != Status.SPAM:
            old = message.status
            message.status, message.spam_at = Status.SPAM, timezone.now()
            retention.apply(message)
            message.save(update_fields=["status", "spam_at", "expires_at"])
            audit.record(
                "message_status", id=str(message.id), to=Status.SPAM, **{"from": old}
            )
        audit.record("message_sender_blocked", id=str(message.id), entry=str(entry.id))
        return entry, message


def remove(entry_id):
    with transaction.atomic():
        removed, _ = BlockedSender.objects.filter(id=entry_id).delete()
        if removed:
            audit.record("sender_unblocked", id=str(entry_id))
        return bool(removed)


def renew(entry_id):
    """A new lifetime from today. An expired entry may be renewed too, unless
    that would take the list past its size."""
    with transaction.atomic():
        _serialise_adds()
        now = timezone.now()
        entry = BlockedSender.objects.select_for_update().filter(id=entry_id).first()
        if entry is None:
            return None
        if entry.expires_at <= now and active(now).count() >= MAX_ENTRIES:
            raise Full
        entry.expires_at = _expiry(now)
        entry.save(update_fields=["expires_at"])
        audit.record("sender_block_renewed", id=str(entry.id))
        return entry
