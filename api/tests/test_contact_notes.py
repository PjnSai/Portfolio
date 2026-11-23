"""A note on a contact message is append-only."""

from datetime import timedelta

import pytest
from django.utils import timezone

from core.models import ContactMessage, ContactNote

pytestmark = pytest.mark.django_db


@pytest.fixture
def message():
    return ContactMessage.objects.create(
        name="A", email="a@example.com", body="Hello there.", expires_at=timezone.now()
    )


def test_a_note_cannot_be_edited(message):
    note = ContactNote.objects.create(message=message, text="First")
    note.text = "Changed"

    with pytest.raises(RuntimeError):
        note.save()

    assert ContactNote.objects.get().text == "First"


def test_a_note_cannot_be_deleted_by_itself(message):
    note = ContactNote.objects.create(message=message, text="First")

    with pytest.raises(RuntimeError):
        note.delete()

    assert ContactNote.objects.count() == 1


def test_notes_go_with_their_message(message):
    ContactNote.objects.create(message=message, text="First")
    ContactNote.objects.create(
        message=message, text="Second", kind="responded_with_details"
    )

    message.delete()

    assert ContactNote.objects.count() == 0


def test_notes_come_back_oldest_first(message):
    start = timezone.now()
    for n, text in enumerate(("one", "two", "three")):
        ContactNote.objects.create(
            message=message, text=text, created_at=start + timedelta(seconds=n)
        )

    assert [n.text for n in message.notes.all()] == ["one", "two", "three"]
