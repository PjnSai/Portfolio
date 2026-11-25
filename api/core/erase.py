"""Delete everything about one email (SPEC 5.8a (e)): a vital action the owner
starts from a message or a contact, for a deletion request.

The pending action holds the keyed hash of the email and counts, never the
address or any text. When it runs, the messages are found again by that hash,
so a message that arrived during the wait goes too, and kept messages and
messages with notes go as well: the owner asked for it, and so does the saved
contact for that email. It runs under the
retention job's lock, in batches of single DELETE statements, inside one
savepoint, so a failure part way leaves everything as it was.
"""

import re

from django.db import transaction
from django.db.models import F, Q, Subquery

from core import blocklist, retention
from core.models import BlockedSender, Contact, ContactMessage, ContactNote

KIND = "erase_sender"
BATCH_SIZE = 500
# Exactly one of these names what the owner started from.
TARGETS = {"message": ContactMessage, "contact": Contact}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HASH = re.compile(r"[0-9a-f]{64}")


def _notes(email_hash):
    return Q(
        message_id__in=ContactMessage.objects.filter(email_hash=email_hash).values("id")
    )


def counts(email_hash):
    return {
        "messages": ContactMessage.objects.filter(email_hash=email_hash).count(),
        "notes": ContactNote.objects.filter(_notes(email_hash)).count(),
        "contacts": Contact.objects.filter(email_hash=email_hash).count(),
    }


def clean(payload):
    """The payload to store, from the message or contact the owner started
    on: the sender's hash, the "also block" choice and what there is now. None
    if it is not valid."""
    named = [name for name in TARGETS if name in payload]
    if len(named) != 1 or set(payload) != {named[0], "also_block"}:
        return None
    target, also_block = payload[named[0]], payload["also_block"]
    if not isinstance(target, str) or not UUID.fullmatch(target):
        return None
    if not isinstance(also_block, bool):
        return None
    row = TARGETS[named[0]].objects.filter(id=target).first()
    if row is None or not row.email_hash:
        return None
    return {
        "email_hash": row.email_hash,
        "also_block": also_block,
        **counts(row.email_hash),
    }


def shown(payload):
    """What the admin is shown of a pending action: the counts and the choice."""
    return {k: v for k, v in payload.items() if k != "email_hash"}


def _batched(model, condition, size):
    """Delete matching rows, one DELETE statement per batch, as the retention
    job does (core.retention)."""
    total = 0
    while True:
        batch = model.objects.filter(condition).order_by("id").values("id")[:size]
        due = model.objects.filter(
            condition, retention._InBatch(F("id"), Subquery(batch))
        )
        removed = due._raw_delete(due.db)
        total += removed
        if removed < size:
            return total


def run(payload, batch_size=None):
    """Counts of what was removed, or None if the payload is not one this
    module made. Raises retention.Busy if the job is running, and
    blocklist.Full if "also block" needs a new entry and the list is full;
    either way nothing is removed."""
    email_hash, also_block = payload.get("email_hash"), payload.get("also_block")
    if not isinstance(email_hash, str) or not HASH.fullmatch(email_hash):
        return None
    if not isinstance(also_block, bool):
        return None
    batch_size = batch_size or BATCH_SIZE
    with transaction.atomic():
        retention._lock()
        # Hold every message so no note can be added while they go.
        list(
            ContactMessage.objects.select_for_update()
            .filter(email_hash=email_hash)
            .values_list("id", flat=True)
        )
        unblocked = 0
        if also_block:
            # Blocked by hash only from now on: a kept address goes.
            blocklist.drop_address(blocklist.ensure(email_hash)[0])
        else:
            gone = BlockedSender.objects.filter(email_hash=email_hash)
            unblocked = gone._raw_delete(gone.db)
        notes = _batched(ContactNote, _notes(email_hash), batch_size)
        messages = _batched(ContactMessage, Q(email_hash=email_hash), batch_size)
        # Only the sender's own messages can be linked to it, and they are gone.
        contact = Contact.objects.filter(email_hash=email_hash)
        contacts = contact._raw_delete(contact.db)
    return {
        "messages": messages,
        "notes": notes,
        "contacts": contacts,
        "unblocked": unblocked,
        "blocked": also_block,
    }
