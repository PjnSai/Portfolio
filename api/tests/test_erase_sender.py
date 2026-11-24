"""Delete everything about this email (SPEC 5.8a (e)): a vital action taken from
a message that removes every message and note from that sender."""

import json
from datetime import timedelta

import pytest
from django.db import connection
from django.db.models import QuerySet
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import audit, blocklist, contact, erase, retention
from core.models import (
    AuditLog,
    BlockedSender,
    ContactMessage,
    ContactNote,
    PendingAction,
)
from tests.conftest import age_sessions, mature, new_message
from tests.test_contact_migrations import at_latest  # noqa: F401
from tests.test_run_retention import other_session  # noqa: F401

pytestmark = pytest.mark.django_db

EMAIL = "erase.me@deletion-example.org"
NAME = "Wilhelmina Quarrender"
BODY = "Please remove everything you hold about me, thank you."
NOTE = "Spoke on the phone about the deletion."
OTHER = "keep.me@deletion-example.org"


def theirs(**fields):
    values = {"name": NAME, "email": EMAIL, "body": BODY}
    values.update(fields)
    return new_message(**values)


def request(api, message, also_block=False):
    return api.post(
        "/vital-actions/request",
        {
            "kind": "erase_sender",
            "payload": {"message": str(message.id), "also_block": also_block},
        },
    )


def matured(api, passkey):
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    age_sessions(minutes=6)
    assert api.elevate(passkey).status_code == 200


def execute(api, action_id):
    return api.post(f"/vital-actions/{action_id}/execute")


def left():
    return set(ContactMessage.objects.values_list("email", flat=True))


@pytest.fixture
def first():
    return theirs()


# Requesting


def test_the_request_needs_a_fresh_passkey(signed_in, first):
    response = request(signed_in, first)

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert PendingAction.objects.count() == 0


def test_the_request_waits_24_hours_and_deletes_nothing(elevated, first):
    response = request(elevated, first)

    assert response.status_code == 201
    action = PendingAction.objects.get()
    assert action.kind == "erase_sender"
    assert action.execute_after - action.requested_at == timedelta(hours=24)
    assert action.expires_at - action.execute_after == timedelta(days=7)
    assert response.json()["state"] == "waiting"
    assert ContactMessage.objects.count() == 1


def test_the_stored_action_holds_the_hash_and_counts_only(elevated, first):
    ContactNote.objects.create(message=first, text=NOTE)
    theirs()

    body = request(elevated, first).json()

    action = PendingAction.objects.get()
    assert action.payload == {
        "email_hash": contact.email_hash(EMAIL),
        "also_block": False,
        "messages": 2,
        "notes": 1,
    }
    stored = json.dumps(list(PendingAction.objects.values()), default=str)
    for private in (EMAIL, NAME, BODY, NOTE, str(first.id)):
        assert private not in stored
    assert body["target"] == {"also_block": False, "messages": 2, "notes": 1}
    assert contact.email_hash(EMAIL) not in json.dumps(body)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"message": "00000000-0000-4000-8000-000000000000", "also_block": False},
        {"message": "not-an-id", "also_block": False},
        {"also_block": False},
        {"message": "MESSAGE"},
        {"message": "MESSAGE", "also_block": "yes"},
        {"message": "MESSAGE", "also_block": 1},
        {"message": "MESSAGE", "also_block": False, "email": EMAIL},
        {"message": "MESSAGE", "also_block": False, "email_hash": "f" * 64},
    ],
)
def test_a_bad_request_is_refused(elevated, first, payload):
    payload = {k: str(first.id) if v == "MESSAGE" else v for k, v in payload.items()}

    response = elevated.post(
        "/vital-actions/request", {"kind": "erase_sender", "payload": payload}
    )

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0


# Running


def test_it_cannot_run_before_the_wait_is_over(elevated, passkey, first):
    action_id = request(elevated, first).json()["id"]
    mature(PendingAction.objects.get(), hours=23, minutes=59)
    age_sessions(minutes=6)
    elevated.elevate(passkey)

    assert execute(elevated, action_id).status_code == 409
    assert ContactMessage.objects.count() == 1


def test_running_needs_a_fresh_passkey(elevated, first):
    action_id = request(elevated, first).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    age_sessions(minutes=6)

    response = execute(elevated, action_id)

    assert response.status_code == 403
    assert ContactMessage.objects.count() == 1


def test_cancel_stops_it(elevated, passkey, first):
    action_id = request(elevated, first).json()["id"]
    age_sessions(minutes=6)

    assert elevated.post(f"/vital-actions/{action_id}/cancel").status_code == 200
    matured(elevated, passkey)

    assert execute(elevated, action_id).status_code == 409
    assert ContactMessage.objects.count() == 1


def test_it_expires_after_the_window(elevated, passkey, first):
    action_id = request(elevated, first).json()["id"]
    mature(PendingAction.objects.get(), days=8, hours=1)
    age_sessions(minutes=6)
    elevated.elevate(passkey)

    assert execute(elevated, action_id).status_code == 409
    assert ContactMessage.objects.count() == 1


def test_everything_from_that_email_goes_and_nothing_else(elevated, passkey, first):
    kept = theirs(kept=True)
    noted = theirs(status="replied")
    ContactNote.objects.create(message=noted, text=NOTE)
    spam = theirs(status="spam", spam_at=timezone.now())
    other = new_message(email=OTHER)
    other_note = ContactNote.objects.create(message=other, text="Their own note.")
    similar = [
        new_message(email=address)
        for address in (
            "erase.me@deletion-example.com",
            "erase.me+1@deletion-example.org",
            "erase.m@deletion-example.org",
        )
    ]
    action_id = request(elevated, first).json()["id"]
    matured(elevated, passkey)

    response = execute(elevated, action_id)

    assert response.status_code == 200
    assert response.json()["state"] == "done"
    gone = {first.id, kept.id, noted.id, spam.id}
    assert not ContactMessage.objects.filter(id__in=gone).exists()
    assert not ContactNote.objects.filter(message_id=noted.id).exists()
    assert set(ContactMessage.objects.values_list("id", flat=True)) == {
        other.id,
        *(m.id for m in similar),
    }
    assert ContactNote.objects.filter(id=other_note.id).exists()


def test_messages_that_arrive_during_the_wait_go_too(elevated, passkey, first):
    action_id = request(elevated, first).json()["id"]
    later = theirs(email="Erase.Me@Deletion-Example.ORG", body="Another one.")
    ContactNote.objects.create(message=later, text=NOTE)
    matured(elevated, passkey)

    execute(elevated, action_id)

    assert ContactMessage.objects.count() == 0
    assert ContactNote.objects.count() == 0
    (entry,) = AuditLog.objects.filter(event="vital_action_executed")
    assert entry.detail["result"] == {
        "messages": 2,
        "notes": 1,
        "unblocked": 0,
        "blocked": False,
    }


def test_a_message_from_the_form_is_found_by_its_hash(elevated, passkey):
    from tests import turnstile as fake
    from tests.test_contact import stored, submit

    fake.spent.clear()
    submit(email=EMAIL)
    (message,) = stored()
    assert message.email_hash == contact.email_hash(EMAIL)
    action_id = request(elevated, message).json()["id"]
    matured(elevated, passkey)

    assert execute(elevated, action_id).status_code == 200
    assert ContactMessage.objects.count() == 0


def test_it_runs_once(elevated, passkey, first):
    action_id = request(elevated, first).json()["id"]
    matured(elevated, passkey)

    assert execute(elevated, action_id).status_code == 200
    assert execute(elevated, action_id).status_code == 409


# Also block


def test_without_also_block_the_entry_is_removed(elevated, passkey, first):
    blocklist.block_email(EMAIL)
    other_entry, _ = blocklist.block_email(OTHER)
    action_id = request(elevated, first, also_block=False).json()["id"]
    matured(elevated, passkey)

    execute(elevated, action_id)

    assert list(BlockedSender.objects.values_list("id", flat=True)) == [other_entry.id]
    (entry,) = AuditLog.objects.filter(event="vital_action_executed")
    assert entry.detail["result"]["unblocked"] == 1


def test_also_block_creates_an_entry_with_the_normal_lifetime(elevated, passkey, first):
    action_id = request(elevated, first, also_block=True).json()["id"]
    matured(elevated, passkey)

    execute(elevated, action_id)

    entry = BlockedSender.objects.get()
    assert entry.email_hash == contact.email_hash(EMAIL)
    expected = blocklist.months_later(timezone.now(), 12).date()
    assert entry.expires_at.date() == expected
    assert blocklist.is_blocked(EMAIL)


def test_also_block_keeps_an_entry_that_is_there(elevated, passkey, first):
    entry, _ = blocklist.block_email(EMAIL, "first block")
    before = BlockedSender.objects.get(id=entry.id).expires_at
    action_id = request(elevated, first, also_block=True).json()["id"]
    matured(elevated, passkey)

    execute(elevated, action_id)

    kept = BlockedSender.objects.get()
    assert (kept.id, kept.expires_at, kept.note) == (entry.id, before, "first block")


def test_also_block_with_a_full_list_runs_nothing(elevated, passkey, first):
    BlockedSender.objects.bulk_create(
        BlockedSender(
            email_hash=f"{n:064x}", expires_at=timezone.now() + timedelta(days=9)
        )
        for n in range(blocklist.MAX_ENTRIES)
    )
    action_id = request(elevated, first, also_block=True).json()["id"]
    matured(elevated, passkey)

    assert execute(elevated, action_id).status_code == 409
    assert ContactMessage.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"


# Audit: the hash and counts only


def test_no_audit_entry_holds_an_email_or_text(elevated, passkey, first):
    ContactNote.objects.create(message=first, text=NOTE)
    action_id = request(elevated, first, also_block=True).json()["id"]
    matured(elevated, passkey)
    execute(elevated, action_id)

    rows = AuditLog.objects.filter(event__startswith="vital_action")
    events = {row.event for row in rows}
    assert {"vital_action_requested", "vital_action_executed"} <= events
    said = json.dumps(list(AuditLog.objects.values()), default=str)
    for private in (EMAIL, NAME, BODY, NOTE, str(first.id)):
        assert private not in said
    executed = rows.get(event="vital_action_executed")
    assert executed.detail["target"] == {
        "email_hash": contact.email_hash(EMAIL),
        "also_block": True,
        "messages": 1,
        "notes": 1,
    }
    assert executed.detail["result"] == {
        "messages": 1,
        "notes": 1,
        "unblocked": 0,
        "blocked": True,
    }
    assert audit.verify_chain().ok


# Deleting safely


def test_it_deletes_in_batches_of_single_statements(elevated, passkey, first):
    for _ in range(4):
        ContactNote.objects.create(message=theirs(), text=NOTE)
    new_message(email=OTHER)
    action = PendingAction.objects.create(
        kind="erase_sender",
        payload={"email_hash": contact.email_hash(EMAIL), "also_block": False},
        requested_at=timezone.now(),
        execute_after=timezone.now(),
        expires_at=timezone.now() + timedelta(days=1),
    )

    with CaptureQueriesContext(connection) as queries:
        result = erase.run(action.payload, batch_size=2)

    assert result["messages"] == 5 and result["notes"] == 4
    sql = [q["sql"] for q in queries.captured_queries]
    message_deletes = [s for s in sql if s.startswith('DELETE FROM "contact_messages"')]
    note_deletes = [s for s in sql if s.startswith('DELETE FROM "contact_notes"')]
    assert len(message_deletes) == 3
    assert len(note_deletes) == 3
    assert all("email_hash" in s for s in message_deletes + note_deletes)
    assert left() == {OTHER}


def test_a_failure_part_way_deletes_nothing(elevated, passkey, first, monkeypatch):
    for _ in range(3):
        ContactNote.objects.create(message=theirs(), text=NOTE)
    blocklist.block_email(EMAIL)
    action_id = request(elevated, first).json()["id"]
    matured(elevated, passkey)
    monkeypatch.setattr(erase, "BATCH_SIZE", 1)
    real = QuerySet._raw_delete
    calls = []

    def fails_on_the_fourth(self, using):
        calls.append(self.model)
        if len(calls) == 4:
            raise RuntimeError("database went away")
        return real(self, using)

    monkeypatch.setattr(QuerySet, "_raw_delete", fails_on_the_fourth)

    with pytest.raises(RuntimeError):
        execute(elevated, action_id)

    # The entry and two notes had gone inside the transaction when it failed.
    assert calls == [BlockedSender, ContactNote, ContactNote, ContactNote]
    monkeypatch.undo()
    assert ContactMessage.objects.count() == 4
    assert ContactNote.objects.count() == 3
    assert BlockedSender.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"
    assert not AuditLog.objects.filter(event="vital_action_executed").exists()


def test_it_waits_for_the_retention_job(elevated, passkey, first, other_session):  # noqa: F811
    action_id = request(elevated, first).json()["id"]
    matured(elevated, passkey)
    other_session.execute("SELECT pg_advisory_lock(%s)", [retention.LOCK_KEY])
    try:
        response = execute(elevated, action_id)
    finally:
        other_session.execute("SELECT pg_advisory_unlock(%s)", [retention.LOCK_KEY])

    assert response.status_code == 409
    assert ContactMessage.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"
    assert execute(elevated, action_id).status_code == 200


def test_a_payload_not_made_here_is_refused(elevated, passkey):
    for payload in (
        {"email_hash": EMAIL, "also_block": False},
        {"email_hash": "F" * 64, "also_block": False},
        {"email_hash": contact.email_hash(EMAIL), "also_block": "no"},
        {"also_block": False},
    ):
        assert erase.run(payload) is None


# Migration 0019


def test_0019_fills_the_hash_for_messages_already_stored(at_latest):  # noqa: F811
    from tests.test_contact_migrations import migrate

    apps = migrate([("core", "0018_blocklist")])
    old = apps.get_model("core", "ContactMessage").objects.create(
        name="A",
        email=" Old.Sender@Example.org",
        body="Hello there.",
        expires_at=timezone.now() + timedelta(days=1),
    )

    apps = migrate([("core", "0019_contact_email_hash")])

    found = apps.get_model("core", "ContactMessage").objects.get(id=old.id)
    assert found.email_hash == contact.email_hash("old.sender@example.org")
    found.delete()
