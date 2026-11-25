"""Contacts (SPEC 5.8a (c)): a record the owner keeps of a sender, separate from
the messages, and the retention rule that keeps linked messages."""

from datetime import timedelta

import pytest
from django.utils import timezone

from core import retention
from core.models import Contact, ContactMessage
from tests.conftest import new_message
from tests.test_contact_migrations import at_latest  # noqa: F401

pytestmark = pytest.mark.django_db

EMAIL = "rowan.ashdown@recruit-example.org"
NAME = "Rowan Ashdown"


def new_contact(email=EMAIL, **fields):
    values = {"name": NAME, "email": email}
    values.update(fields)
    return Contact.objects.create(**values)


def expired(**fields):
    return new_message(expires_at=timezone.now() - timedelta(days=1), **fields)


def ids():
    return set(ContactMessage.objects.values_list("id", flat=True))


# Retention


def test_a_linked_message_past_its_date_survives_the_job():
    person = new_contact()
    linked = expired(email=EMAIL, contact=person)
    loose = expired(email=EMAIL)

    counts = retention.run()

    assert ids() == {linked.id}
    assert loose.id not in ids()
    assert counts["deleted"] == 1
    assert counts["exempt"] == 1


def test_unlinking_makes_it_due_again():
    linked = expired(email=EMAIL, contact=new_contact())
    retention.run()
    assert ids() == {linked.id}

    ContactMessage.objects.filter(id=linked.id).update(contact=None)
    retention.run()

    assert ids() == set()


def test_the_rule_is_in_the_one_delete_statement():
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    expired(email=EMAIL, contact=new_contact())

    with CaptureQueriesContext(connection) as queries:
        retention.run()

    (delete,) = [
        q["sql"]
        for q in queries.captured_queries
        if q["sql"].startswith('DELETE FROM "contact_messages"')
    ]
    assert '"contact_messages"."contact_id" IS NULL' in delete


def test_a_dry_run_counts_a_linked_message_as_exempt():
    expired(email=EMAIL, contact=new_contact())

    counts = retention.run(dry_run=True)

    assert (counts["deleted"], counts["exempt"]) == (0, 1)


# Messages and contacts are separate


def test_deleting_a_contact_unlinks_its_messages_and_deletes_none():
    person = new_contact()
    first = new_message(email=EMAIL, contact=person)
    second = new_message(email=EMAIL, contact=person)

    person.delete()

    assert ids() == {first.id, second.id}
    assert set(ContactMessage.objects.values_list("contact", flat=True)) == {None}


def test_deleting_a_message_leaves_the_contact():
    person = new_contact()
    message = new_message(email=EMAIL, contact=person)

    message.delete()

    assert Contact.objects.filter(id=person.id).exists()


def test_one_contact_per_email():
    from django.db import IntegrityError, transaction

    new_contact()

    with pytest.raises(IntegrityError), transaction.atomic():
        new_contact(email=" Rowan.Ashdown@Recruit-Example.ORG ")


# Migration 0020


def test_0020_adds_contacts_and_the_link_and_reverses(at_latest):  # noqa: F811
    from tests.test_contact_migrations import columns, migrate, tables

    migrate([("core", "0019_contact_email_hash")])
    assert "contacts" not in tables()
    assert "contact_id" not in columns("contact_messages")

    migrate([("core", "0020_contacts")])

    assert "contacts" in tables()
    assert columns("contacts") == {
        "id",
        "name",
        "email",
        "email_hash",
        "organisation",
        "tags",
        "notes",
        "follow_up",
        "created_at",
        "updated_at",
    }
    assert "contact_id" in columns("contact_messages")
