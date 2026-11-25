"""Contacts (SPEC 5.8a (c)): senders the owner keeps a record of.

A contact is made from a message and holds that sender's name and email, so
there is one per email (the keyed hash is unique). Only messages from the same
email can be linked to it; a linked message is kept by the daily job. Deleting
a contact unlinks its messages and deletes none. The keyed hash is never shown.
Audit entries hold the contact id and the names of changed fields only.
"""

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from core import audit, inbox
from core.models import Contact, ContactMessage

PAGE_SIZE = 25
EDITABLE = ("name", "organisation", "tags", "notes", "follow_up")


class Taken(Exception):
    """There is already a contact for this email."""


class OtherSender(Exception):
    """The message is from a different email."""


def summary(contact):
    return {
        "id": str(contact.id),
        "name": contact.name,
        "email": contact.email,
        "organisation": contact.organisation,
        "tags": contact.tags,
        "follow_up": contact.follow_up.isoformat() if contact.follow_up else None,
        "created_at": contact.created_at.isoformat(),
        "updated_at": contact.updated_at.isoformat(),
    }


def detail(contact):
    return {
        **summary(contact),
        "notes": contact.notes,
        "messages": [inbox.summary(message) for message in contact.messages.all()],
    }


def listing(search="", tag="", due=False):
    """Contacts narrowed by a search over name, organisation and email, a tag,
    and whether the follow-up date has come (today or earlier, UTC)."""
    rows = Contact.objects.all()
    if search:
        rows = rows.filter(
            Q(name__icontains=search)
            | Q(organisation__icontains=search)
            | Q(email__icontains=search)
        )
    if tag:
        rows = rows.filter(tags__contains=[tag])
    if due:
        rows = rows.filter(follow_up__lte=timezone.now().date())
    return rows


def _message(message_id):
    return ContactMessage.objects.select_for_update().filter(id=message_id).first()


def _contact(contact_id):
    return Contact.objects.select_for_update().filter(id=contact_id).first()


def create(message_id, fields):
    """A contact from a message's sender, linked to that message. None if there
    is no such message. Raises Taken if the email already has a contact."""
    with transaction.atomic():
        message = _message(message_id)
        if message is None:
            return None
        contact = Contact(name=message.name, email=message.email, **fields)
        try:
            with transaction.atomic():
                contact.save(force_insert=True)
        except IntegrityError:
            raise Taken from None
        message.contact = contact
        message.save(update_fields=["contact"])
        audit.record("contact_created", id=str(contact.id))
        return contact


def edit(contact_id, fields):
    with transaction.atomic():
        contact = _contact(contact_id)
        if contact is None:
            return None
        changed = sorted(
            name
            for name in EDITABLE
            if name in fields and fields[name] != getattr(contact, name)
        )
        if changed:
            for name in changed:
                setattr(contact, name, fields[name])
            contact.save(update_fields=[*changed, "updated_at"])
            audit.record("contact_changed", id=str(contact.id), fields=changed)
        return contact


def link(contact_id, message_id, linked):
    """Link or unlink one of the sender's messages. None if either is missing.
    Raises OtherSender if the message is from a different email."""
    with transaction.atomic():
        contact = _contact(contact_id)
        message = _message(message_id) if contact else None
        if message is None:
            return None
        if message.email_hash != contact.email_hash:
            raise OtherSender
        target = contact if linked else None
        if (message.contact_id == contact.id) != linked:
            message.contact = target
            message.save(update_fields=["contact"])
            event = "contact_message_linked" if linked else "contact_message_unlinked"
            audit.record(event, id=str(contact.id))
        return contact


def delete(contact_id):
    """Delete the contact; its messages stay, unlinked."""
    with transaction.atomic():
        contact = _contact(contact_id)
        if contact is None:
            return False
        contact.delete()
        audit.record("contact_deleted", id=str(contact_id))
        return True
