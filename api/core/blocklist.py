"""Senders the owner has blocked (SPEC 5.8a (d), 10.13).

An entry is found by the keyed hash of an email, the same one the form counts
by (core.contact.email_hash). By default only the hash is stored, so the list
cannot be read back as addresses; the owner may choose, per block, to keep the
address so the list can show it. A kept address is written only when the entry
is made, shown only to the signed-in owner while the entry still blocks, and
goes with the entry. The form answers a blocked sender exactly as it answers
dropped spam, and nothing is stored; the entry only counts that it stopped one.
An entry blocks until expires_at; the owner may renew it, and the daily job
removes it once it has expired. Nothing here returns the hash.
"""

import calendar

from django.db import transaction
from django.db.models import F
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


def hit(email):
    """True if an entry still blocks this email. Finding it and counting the
    hit are one UPDATE statement, so there is no second lookup."""
    now = timezone.now()
    with transaction.atomic():
        found = active(now).filter(email_hash=contact.email_hash(email))
        return found.update(hit_count=F("hit_count") + 1, last_hit_at=now) > 0


def describe(entry):
    blocking = entry.expires_at > timezone.now()
    return {
        "id": str(entry.id),
        "email": entry.email if blocking else None,
        "note": entry.note,
        "created_at": entry.created_at.isoformat(),
        "expires_at": entry.expires_at.isoformat(),
        "hit_count": entry.hit_count,
        "last_hit_at": entry.last_hit_at.isoformat() if entry.last_hit_at else None,
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


def _replace(entry, **fields):
    """The entry made again under the same id with fields changed. The app role
    cannot rewrite a stored email or hash, so this deletes and adds it."""
    names = (
        "id",
        "email_hash",
        "email",
        "note",
        "created_at",
        "expires_at",
        "hit_count",
        "last_hit_at",
    )
    values = {name: getattr(entry, name) for name in names}
    values.update(fields)
    BlockedSender.objects.filter(id=entry.id).delete()
    return BlockedSender.objects.create(**values)


def ensure(email_hash, note="", email=None):
    """The entry for this hash, added with the normal lifetime if there is none
    that still blocks. One that is there and blocking is left as it is,
    including whether it keeps an address. One that has expired is renewed and
    keeps an address only if one is given now. email is the address to keep,
    None for the hash only. Must run inside a transaction. Raises Full."""
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
        entry = _replace(
            entry, email=email, expires_at=_expiry(now), note=note or entry.note
        )
        audit.record("sender_block_renewed", id=str(entry.id))
        return entry, False
    entry = BlockedSender.objects.create(
        email_hash=email_hash,
        email=email,
        note=note,
        created_at=now,
        expires_at=_expiry(now),
    )
    audit.record("sender_blocked", id=str(entry.id))
    return entry, True


def drop_address(entry):
    """The same entry with its address removed; hit counts and dates stay."""
    if entry.email is None:
        return entry
    return _replace(entry, email=None)


def block_email(email, note="", keep_address=False):
    with transaction.atomic():
        return ensure(contact.email_hash(email), note, email if keep_address else None)


def block_message(message_id, note="", keep_address=False):
    """Block the message's sender and move the message to spam. None if there
    is no such message."""
    with transaction.atomic():
        message = ContactMessage.objects.select_for_update().filter(id=message_id)
        message = message.first()
        if message is None:
            return None, None
        email = message.email if keep_address else None
        entry, _ = ensure(contact.email_hash(message.email), note, email)
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
