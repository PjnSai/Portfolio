"""The owner's inbox: what each message looks like to the admin, and the status
rules. Every change here is written together with its audit entry, so a change
and its record stand or fall together. Audit detail holds ids and states only,
never a name, an address or any text."""

from django.db import transaction
from django.db.models import Count
from django.utils import timezone

from core import audit
from core.models import ContactMessage, ContactNote

Status = ContactMessage.Status
PAGE_SIZE = 20
SNIPPET = 140
RESPONDED_TEXT = "Responded with details."

# What the owner may set by hand. Spam only leaves through "Not spam", so a
# quarantined message is never moved by a mis-click on a status button.
TRANSITIONS = {
    Status.NEW: {Status.READ, Status.REPLIED, Status.ARCHIVED, Status.SPAM},
    Status.READ: {Status.NEW, Status.REPLIED, Status.ARCHIVED, Status.SPAM},
    Status.REPLIED: {Status.READ, Status.ARCHIVED, Status.SPAM},
    Status.ARCHIVED: {Status.NEW, Status.READ, Status.REPLIED, Status.SPAM},
    Status.SPAM: set(),
}


class Refused(Exception):
    """The change is not allowed from the message's current state."""


def snippet(body):
    return " ".join(body.split())[:SNIPPET]


def summary(message):
    return {
        "id": str(message.id),
        "name": message.name,
        "email": message.email,
        "status": message.status,
        "created_at": message.created_at.isoformat(),
        "kept": message.kept,
        "snippet": snippet(message.body),
    }


def describe_note(note):
    return {
        "id": str(note.id),
        "kind": note.kind,
        "text": note.text,
        "created_at": note.created_at.isoformat(),
    }


def detail(message):
    return {
        "id": str(message.id),
        "name": message.name,
        "email": message.email,
        "body": message.body,
        "status": message.status,
        "created_at": message.created_at.isoformat(),
        "read_at": message.read_at.isoformat() if message.read_at else None,
        "kept": message.kept,
        "expires_at": message.expires_at.isoformat(),
        "notes": [describe_note(note) for note in message.notes.all()],
    }


def listing(status):
    """The rows for a tab. No tab means the main inbox: everything but spam."""
    rows = ContactMessage.objects.all()
    if status is None:
        return rows.exclude(status=Status.SPAM)
    if status == "all":
        return rows
    return rows.filter(status=status)


def counts():
    found = dict(
        ContactMessage.objects.values_list("status").annotate(total=Count("id"))
    )
    return {status.value: found.get(status.value, 0) for status in Status}


def _locked(message_id):
    return ContactMessage.objects.select_for_update().filter(id=message_id).first()


def open_message(message_id):
    """The message for its first view, marked read if it was new. A quarantined
    message is left exactly as it is."""
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        if message.read_at is None and message.status != Status.SPAM:
            message.read_at = timezone.now()
            if message.status == Status.NEW:
                message.status = Status.READ
            message.save(update_fields=["read_at", "status"])
            audit.record("message_read", id=str(message.id))
        return message


def set_status(message_id, new):
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        if new == message.status:
            return message
        if new not in TRANSITIONS[message.status]:
            raise Refused
        old, message.status = message.status, new
        message.save(update_fields=["status"])
        audit.record("message_status", id=str(message.id), to=new, **{"from": old})
        return message


def add_note(message_id, text):
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        note = ContactNote.objects.create(message=message, text=text)
        audit.record("message_note", id=str(message.id), note=str(note.id))
        return note


def log_response(message_id, text):
    """A "responded with details" note, and the message becomes replied."""
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        if message.status == Status.SPAM:
            raise Refused
        note = ContactNote.objects.create(
            message=message,
            text=text or RESPONDED_TEXT,
            kind=ContactNote.Kind.RESPONDED,
        )
        if message.status != Status.REPLIED:
            message.status = Status.REPLIED
            message.save(update_fields=["status"])
        audit.record("message_responded", id=str(message.id), note=str(note.id))
        return note


def set_kept(message_id, kept):
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        message.kept = kept
        message.save(update_fields=["kept"])
        audit.record("message_kept", id=str(message.id), kept=kept)
        return message


def not_spam(message_id):
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return None
        if message.status != Status.SPAM:
            raise Refused
        message.status = Status.NEW
        message.save(update_fields=["status"])
        audit.record("message_not_spam", id=str(message.id))
        return message


def delete(message_id):
    """Remove the message and its notes for good. The audit entry has the id."""
    with transaction.atomic():
        message = _locked(message_id)
        if message is None:
            return False
        message.delete()
        audit.record("message_deleted", id=str(message_id))
        return True
