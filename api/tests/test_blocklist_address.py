"""Blocklist: the owner's choice to keep an address, the hit counter and the
rule against addresses in notes."""

import json
import logging
from datetime import timedelta

import pytest
from django.apps import apps
from django.db import DatabaseError, connection
from django.db.models import QuerySet
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import contact, erase, retention
from core.models import AuditLog, BlockedSender, ContactMessage
from tests import turnstile as fake
from tests.conftest import new_message
from tests.test_blocklist import BLOCKED, block
from tests.test_contact import SENT, stored, submit
from tests.test_contact_migrations import at_latest  # noqa: F401

pytestmark = pytest.mark.django_db

OTHER = "someone.fine@example.org"


@pytest.fixture(autouse=True)
def fresh_stand_in():
    fake.spent.clear()
    fake.asked.clear()


def entries(api):
    return api.get("/blocklist").json()["entries"]


def whole_database():
    """Every row of every table the app has, as text."""
    rows = [
        list(model.objects.values())
        for model in apps.get_app_config("core").get_models()
    ]
    return json.dumps(rows, default=str).lower()


# The choice


def test_by_default_only_the_hash_is_stored(elevated):
    elevated.post("/blocklist", {"email": BLOCKED})
    message = new_message(email=OTHER)
    elevated.post(f"/messages/{message.id}/block", {})

    assert list(BlockedSender.objects.values_list("email", flat=True)) == [None, None]
    assert [e["email"] for e in entries(elevated)] == [None, None]
    stored_rows = json.dumps(list(BlockedSender.objects.values()), default=str)
    assert BLOCKED not in stored_rows and OTHER not in stored_rows


def test_keep_address_stores_it_and_the_list_shows_it(elevated):
    typed = elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    message = new_message(email=OTHER)
    from_message = elevated.post(
        f"/messages/{message.id}/block", {"keep_address": True}
    )

    assert typed.status_code == 201
    assert typed.json()["email"] == BLOCKED
    assert from_message.json()["entry"]["email"] == OTHER
    assert {e["email"] for e in entries(elevated)} == {BLOCKED, OTHER}
    assert set(BlockedSender.objects.values_list("email", flat=True)) == {
        BLOCKED,
        OTHER,
    }
    assert (
        contact.email_hash(BLOCKED) not in elevated.get("/blocklist").content.decode()
    )


def test_keep_address_false_is_the_same_as_leaving_it_out(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": False})

    assert BlockedSender.objects.get().email is None


@pytest.mark.parametrize("value", ["yes", 1, None, "true"])
def test_keep_address_must_be_true_or_false(elevated, value):
    message = new_message(email=OTHER)

    typed = elevated.post("/blocklist", {"email": BLOCKED, "keep_address": value})
    from_message = elevated.post(
        f"/messages/{message.id}/block", {"keep_address": value}
    )

    assert (typed.status_code, from_message.status_code) == (400, 400)
    assert BlockedSender.objects.count() == 0


def test_only_the_signed_in_owner_sees_a_kept_address(api, passkey):
    BlockedSender.objects.create(
        email_hash=contact.email_hash(BLOCKED),
        email=BLOCKED,
        expires_at=timezone.now() + timedelta(days=30),
    )

    response = api.get("/blocklist")

    assert response.status_code == 401
    assert BLOCKED not in response.content.decode()


def test_blocking_again_leaves_an_entry_that_blocks_as_it_is(elevated):
    first = elevated.post("/blocklist", {"email": BLOCKED}).json()
    again = elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})

    assert again.json()["id"] == first["id"]
    assert BlockedSender.objects.get().email is None

    BlockedSender.objects.all().delete()
    kept = elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True}).json()
    message = new_message(email=BLOCKED)
    elevated.post(f"/messages/{message.id}/block", {"keep_address": False})

    entry = BlockedSender.objects.get()
    assert (str(entry.id), entry.email) == (kept["id"], BLOCKED)


def test_an_expired_entry_blocked_again_takes_the_new_choice(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    BlockedSender.objects.update(
        expires_at=timezone.now() - timedelta(days=1), hit_count=4
    )
    old = BlockedSender.objects.get()

    response = elevated.post("/blocklist", {"email": BLOCKED})

    entry = BlockedSender.objects.get()
    assert (entry.id, entry.email, entry.hit_count) == (old.id, None, 4)
    assert entry.expires_at > timezone.now()
    assert response.json()["email"] is None


# Expiry


def test_an_expired_entry_no_longer_shows_its_address(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    BlockedSender.objects.update(expires_at=timezone.now() - timedelta(minutes=1))

    assert [e["email"] for e in entries(elevated)] == [None]


def test_the_daily_job_removes_an_expired_entry_and_its_address(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    BlockedSender.objects.update(expires_at=timezone.now() - timedelta(minutes=1))

    assert retention.run()["blocklist_deleted"] == 1

    assert BlockedSender.objects.count() == 0
    assert BLOCKED not in whole_database()


# Delete everything with "also block"


def erase_now(email, also_block):
    return erase.run(
        {"email_hash": contact.email_hash(email), "also_block": also_block}
    )


def test_erase_with_also_block_leaves_no_address_anywhere(elevated):
    message = new_message(name="Pest", email=BLOCKED)
    elevated.post(f"/messages/{message.id}/block", {"keep_address": True})
    BlockedSender.objects.update(hit_count=3, last_hit_at=timezone.now())
    before = BlockedSender.objects.get()

    result = erase_now(BLOCKED, also_block=True)

    assert result["blocked"] is True
    after = BlockedSender.objects.get()
    assert after.email is None
    assert (after.id, after.email_hash, after.expires_at) == (
        before.id,
        before.email_hash,
        before.expires_at,
    )
    assert (after.hit_count, after.last_hit_at) == (3, before.last_hit_at)
    assert ContactMessage.objects.count() == 0
    assert BLOCKED not in whole_database()
    assert submit(email=BLOCKED).json() == SENT
    assert stored() == []


def test_erase_with_also_block_renews_an_expired_entry_without_its_address(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    BlockedSender.objects.update(expires_at=timezone.now() - timedelta(days=1))
    new_message(email=BLOCKED)

    erase_now(BLOCKED, also_block=True)

    entry = BlockedSender.objects.get()
    assert entry.email is None and entry.expires_at > timezone.now()
    assert BLOCKED not in whole_database()


def test_erase_without_also_block_removes_the_entry_and_its_address(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    new_message(email=BLOCKED)

    assert erase_now(BLOCKED, also_block=False)["unblocked"] == 1

    assert BlockedSender.objects.count() == 0
    assert BLOCKED not in whole_database()


def test_a_failure_after_dropping_the_address_keeps_it(elevated, monkeypatch):
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    new_message(email=BLOCKED)
    real = QuerySet._raw_delete

    def fails_on_messages(self, using):
        if self.model is ContactMessage:
            raise RuntimeError("database went away")
        return real(self, using)

    monkeypatch.setattr(QuerySet, "_raw_delete", fails_on_messages)

    with pytest.raises(RuntimeError):
        erase_now(BLOCKED, also_block=True)

    monkeypatch.undo()
    assert BlockedSender.objects.get().email == BLOCKED
    assert ContactMessage.objects.count() == 1


# The hit counter


def test_each_blocked_attempt_counts_once():
    entry = block()
    before = timezone.now()

    for n in range(3):
        assert submit(email=BLOCKED, ip=f"198.51.100.{n}").json() == SENT

    entry.refresh_from_db()
    assert entry.hit_count == 3
    assert entry.last_hit_at >= before
    assert stored() == []


def test_other_senders_and_expired_entries_count_nothing():
    entry = block()
    old = block(email=OTHER, expires_at=timezone.now() - timedelta(seconds=1))

    submit(email="third.person@example.org")
    submit(email=OTHER, ip="198.51.100.7")

    entry.refresh_from_db()
    old.refresh_from_db()
    assert (entry.hit_count, entry.last_hit_at) == (0, None)
    assert (old.hit_count, old.last_hit_at) == (0, None)
    assert len(stored()) == 2


def test_a_refused_turnstile_counts_nothing():
    entry = block()

    submit(email=BLOCKED, turnstile="wrong")

    entry.refresh_from_db()
    assert entry.hit_count == 0


def test_finding_and_counting_is_one_statement():
    block()

    with CaptureQueriesContext(connection) as queries:
        submit(email=BLOCKED)

    touching = [q["sql"] for q in queries if "blocked_senders" in q["sql"]]
    assert len(touching) == 1
    assert touching[0].startswith('UPDATE "blocked_senders"')
    assert '"hit_count" = ' in touching[0] and '"expires_at" > ' in touching[0]


@pytest.mark.parametrize("email", [BLOCKED, OTHER])
def test_a_failing_block_check_answers_503_and_stores_nothing(monkeypatch, email):
    block()
    real = QuerySet.update

    def fails(self, **values):
        if self.model is BlockedSender:
            raise DatabaseError("statement failed")
        return real(self, **values)

    monkeypatch.setattr(QuerySet, "update", fails)

    response = submit(email=email)

    assert response.status_code == 503
    assert len(stored()) == 0


def test_no_email_or_hash_in_logs_or_audit(elevated, caplog):
    caplog.set_level(logging.DEBUG)
    elevated.post("/blocklist", {"email": BLOCKED, "keep_address": True})
    message = new_message(email=OTHER)
    elevated.post(f"/messages/{message.id}/block", {"keep_address": True})
    submit(email=BLOCKED)
    submit(email=OTHER, ip="198.51.100.3")
    erase_now(BLOCKED, also_block=True)

    said = caplog.text + json.dumps(
        list(AuditLog.objects.values("event", "detail")), default=str
    )
    for secret in (BLOCKED, OTHER):
        assert secret not in said
        assert contact.email_hash(secret) not in said


# Notes


@pytest.mark.parametrize("note", ["pest@example.org", "write to @ them", "@", " x@y "])
def test_a_note_with_an_at_sign_is_refused_on_both_routes(elevated, note):
    message = new_message(email=OTHER)

    typed = elevated.post("/blocklist", {"email": BLOCKED, "note": note})
    from_message = elevated.post(f"/messages/{message.id}/block", {"note": note})

    assert (typed.status_code, from_message.status_code) == (400, 400)
    assert "note" in typed.json()["errors"]
    assert BlockedSender.objects.count() == 0
    message.refresh_from_db()
    assert message.status == "new"


def test_a_note_without_one_is_accepted(elevated):
    response = elevated.post(
        "/blocklist", {"email": BLOCKED, "note": "Same advert, four times."}
    )

    assert response.status_code == 201


# Migration 0021


def test_0021_adds_the_address_and_counter_and_reverses(at_latest):  # noqa: F811
    from tests.test_contact_migrations import columns, migrate

    migrate([("core", "0020_contacts")])
    assert not {"email", "hit_count", "last_hit_at"} & columns("blocked_senders")

    migrate([("core", "0021_blocklist_address_hits")])

    assert {"email", "hit_count", "last_hit_at"} <= columns("blocked_senders")
