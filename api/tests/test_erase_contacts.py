"""Delete everything about an email also removes the saved contact for it, and
can be started from that contact."""

import json

import pytest
from django.db.models import QuerySet

from core import erase
from core.models import (
    AuditLog,
    BlockedSender,
    Contact,
    ContactMessage,
    ContactNote,
    PendingAction,
)
from tests.conftest import new_message
from tests.test_erase_sender import (
    BODY,
    EMAIL,
    NAME,
    NOTE,
    OTHER,
    execute,
    matured,
    theirs,
)

pytestmark = pytest.mark.django_db

ORG = "Halverton Recruitment"


def contact_for(message, **fields):
    person = Contact.objects.create(name=message.name, email=message.email, **fields)
    ContactMessage.objects.filter(id=message.id).update(contact=person)
    return person


def ask(api, also_block=False, **target):
    return api.post(
        "/vital-actions/request",
        {"kind": "erase_sender", "payload": {**target, "also_block": also_block}},
    )


@pytest.fixture
def first():
    return theirs()


@pytest.fixture
def person(first):
    return contact_for(first, organisation=ORG, notes="Private notes on them.")


@pytest.fixture
def others():
    """Another sender with their own contact, which must be left alone."""
    message = new_message(email=OTHER)
    return message, contact_for(message)


def test_from_a_message_the_contact_goes_too(elevated, passkey, first, person, others):
    ContactNote.objects.create(message=first, text=NOTE)
    action_id = ask(elevated, message=str(first.id)).json()["id"]
    assert PendingAction.objects.get().payload["contacts"] == 1
    matured(elevated, passkey)

    assert execute(elevated, action_id).status_code == 200

    assert not Contact.objects.filter(id=person.id).exists()
    assert ContactMessage.objects.filter(email=EMAIL).count() == 0
    other_message, other_contact = others
    assert Contact.objects.filter(id=other_contact.id).exists()
    other_message.refresh_from_db()
    assert other_message.contact_id == other_contact.id
    (entry,) = AuditLog.objects.filter(event="vital_action_executed")
    assert entry.detail["result"] == {
        "messages": 1,
        "notes": 1,
        "contacts": 1,
        "unblocked": 0,
        "blocked": False,
    }


def test_it_can_start_from_a_contact(elevated, passkey, first, person, others):
    later = theirs(body="Another message, not linked.")

    response = ask(elevated, contact=str(person.id))

    assert response.status_code == 201
    assert response.json()["target"] == {
        "also_block": False,
        "messages": 2,
        "notes": 0,
        "contacts": 1,
    }
    matured(elevated, passkey)
    assert execute(elevated, response.json()["id"]).status_code == 200
    assert not Contact.objects.filter(id=person.id).exists()
    assert not ContactMessage.objects.filter(id__in=[first.id, later.id]).exists()
    assert Contact.objects.filter(id=others[1].id).exists()


def test_a_contact_with_no_messages_left_goes_too(elevated, passkey, first, person):
    action_id = ask(elevated, contact=str(person.id)).json()["id"]
    ContactMessage.objects.filter(id=first.id).delete()
    matured(elevated, passkey)

    execute(elevated, action_id)

    assert Contact.objects.count() == 0


@pytest.mark.parametrize(
    "payload",
    [
        {"message": "MESSAGE", "contact": "CONTACT", "also_block": False},
        {"contact": "CONTACT"},
        {"contact": "00000000-0000-4000-8000-000000000000", "also_block": False},
        {"contact": "not-an-id", "also_block": False},
        {"contact": 5, "also_block": False},
        {"contact": "CONTACT", "also_block": "yes"},
        {"contact": "CONTACT", "also_block": False, "email": EMAIL},
    ],
)
def test_a_bad_request_is_refused(elevated, first, person, payload):
    ids = {"MESSAGE": str(first.id), "CONTACT": str(person.id)}
    payload = {
        k: ids.get(v, v) if isinstance(v, str) else v for k, v in payload.items()
    }

    response = elevated.post(
        "/vital-actions/request", {"kind": "erase_sender", "payload": payload}
    )

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0


@pytest.mark.parametrize("failing", [ContactNote, ContactMessage, Contact])
def test_a_failure_at_any_step_deletes_nothing(
    elevated, passkey, first, person, monkeypatch, failing
):
    ContactNote.objects.create(message=first, text=NOTE)
    action_id = ask(elevated, contact=str(person.id)).json()["id"]
    matured(elevated, passkey)
    real = QuerySet._raw_delete

    def fails(self, using):
        if self.model is failing:
            raise RuntimeError("database went away")
        return real(self, using)

    monkeypatch.setattr(QuerySet, "_raw_delete", fails)

    with pytest.raises(RuntimeError):
        execute(elevated, action_id)

    monkeypatch.undo()
    assert Contact.objects.filter(id=person.id).exists()
    assert ContactMessage.objects.filter(id=first.id, contact=person).exists()
    assert ContactNote.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"


def test_the_contact_goes_last_in_the_same_run(elevated, passkey, first, person):
    action_id = ask(elevated, contact=str(person.id)).json()["id"]
    matured(elevated, passkey)
    real = QuerySet._raw_delete
    order = []

    def noted(self, using):
        order.append(self.model)
        return real(self, using)

    from unittest import mock

    with mock.patch.object(QuerySet, "_raw_delete", noted):
        execute(elevated, action_id)

    assert order == [BlockedSender, ContactNote, ContactMessage, Contact]


def test_no_stored_or_audited_row_holds_the_contact_details(
    elevated, passkey, first, person
):
    action_id = ask(elevated, contact=str(person.id)).json()["id"]
    matured(elevated, passkey)
    execute(elevated, action_id)

    said = json.dumps(
        [
            *AuditLog.objects.values("event", "detail"),
            *PendingAction.objects.values("payload"),
        ],
        default=str,
    )
    for private in (EMAIL, NAME, BODY, ORG, "Private notes on them.", str(person.id)):
        assert private not in said


def test_a_payload_made_from_a_contact_runs_like_one_from_a_message(person):
    payload = erase.clean({"contact": str(person.id), "also_block": False})

    assert set(payload) == {"email_hash", "also_block", "messages", "notes", "contacts"}
    assert erase.run(payload)["contacts"] == 1
