"""The sender blocklist (SPEC 5.8a (d), 10.13): what a blocked sender sees,
what is stored, the admin routes, the size cap and the lifetime."""

import json
import logging
from datetime import timedelta

import pytest
from django.utils import timezone

from core import admin_urls, audit, blocklist, cache, contact, limits, retention
from core.authz import Level
from core.models import AuditLog, BlockedSender, ContactMessage
from tests import turnstile as fake
from tests.conftest import new_message
from tests.test_contact import SENT, stored, submit
from tests.test_contact_migrations import at_latest  # noqa: F401

pytestmark = pytest.mark.django_db

BLOCKED = "pest.sender@blocked-example.org"
NOTE = "Sent the same advert four times"


@pytest.fixture(autouse=True)
def fresh_stand_in():
    fake.spent.clear()
    fake.asked.clear()


def block(email=BLOCKED, **fields):
    values = {
        "email_hash": contact.email_hash(email),
        "expires_at": timezone.now() + timedelta(days=30),
    }
    values.update(fields)
    return BlockedSender.objects.create(**values)


def redis_keys():
    return sorted(key.decode() for key in cache.client().keys("*"))


def everything_said(response, caplog):
    return response.content.decode() + caplog.text


# A blocked sender at the form


def test_a_blocked_sender_is_told_received_and_nothing_is_stored(caplog):
    caplog.set_level(logging.INFO)
    block()

    response = submit(email=BLOCKED)

    assert response.status_code == 201
    assert response.json() == SENT
    assert stored() == []
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("core")]
    assert lines == ["contact outcome=blocked_dropped"]


def test_the_blocked_answer_is_byte_for_byte_a_stored_answer():
    block()

    blocked = submit(email=BLOCKED)
    accepted = submit()

    assert blocked.status_code == accepted.status_code
    assert blocked.content == accepted.content
    assert blocked["Content-Type"] == accepted["Content-Type"]


def test_a_blocked_sender_uses_no_cap(settings):
    block()
    before = redis_keys()

    for n in range(10):
        submit(email=BLOCKED, ip=f"198.51.100.{n}")

    used = [k for k in redis_keys() if k not in before]
    assert used and all(k.startswith("contact:address:") for k in used)
    assert not any(k.startswith(("contact:email", "contact:human")) for k in used)
    assert not any(k.startswith(("contact:spam", "contact:body")) for k in used)


def test_blocked_spam_uses_no_spam_cap_either():
    block()

    submit(email=BLOCKED, website="filled")

    assert not any(k.startswith("contact:spam") for k in redis_keys())


def test_a_blocked_sender_never_reaches_the_daily_cap(settings):
    block()
    for n in range(30):
        submit(email=BLOCKED, ip=f"198.51.100.{n}")

    assert [submit(ip=f"198.51.101.{n}").status_code for n in range(25)] == [201] * 25


def test_the_block_is_checked_after_turnstile():
    block()

    response = submit(email=BLOCKED, turnstile="wrong")

    assert response.status_code == 400
    assert response.json()["code"] == "challenge"


def test_case_and_spaces_do_not_get_past_a_block():
    block()

    submit(email="Pest.Sender@Blocked-Example.ORG")

    assert stored() == []


@pytest.mark.parametrize(
    "similar",
    [
        "pest.sender@blocked-example.com",
        "pest.sender1@blocked-example.org",
        "pest.sende@blocked-example.org",
        "pest.sender+1@blocked-example.org",
        "pestsender@blocked-example.org",
        "pest.sender@mail.blocked-example.org",
    ],
)
def test_a_similar_address_is_not_blocked(similar):
    block()

    assert submit(email=similar).status_code == 201

    (message,) = stored()
    assert message.email == similar


def test_neither_the_email_nor_its_hash_appears_in_logs_or_responses(caplog):
    caplog.set_level(logging.DEBUG)
    block()

    response = submit(email=BLOCKED)

    said = everything_said(response, caplog)
    assert BLOCKED not in said
    assert contact.email_hash(BLOCKED) not in said


def test_an_expired_entry_no_longer_blocks():
    block(expires_at=timezone.now() - timedelta(seconds=1))

    submit(email=BLOCKED)

    assert len(stored()) == 1


# The list as the owner sees it


def test_a_plain_session_can_read_the_list(signed_in):
    entry = block(note=NOTE)

    body = signed_in.get("/blocklist").json()

    assert body["max_entries"] == 500
    assert body["active"] == 1
    assert body["entries"] == [blocklist.describe(entry)]
    assert set(body["entries"][0]) == {"id", "note", "created_at", "expires_at"}


def test_the_list_never_shows_the_email_or_hash(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "note": NOTE})
    message = new_message(email="other@example.org")
    elevated.post(f"/messages/{message.id}/block", {})

    said = elevated.get("/blocklist").content.decode()

    for secret in (BLOCKED, "other@example.org"):
        assert secret not in said
        assert contact.email_hash(secret) not in said
    assert NOTE in said


def test_an_address_typed_in_is_blocked_by_hash_only(elevated):
    response = elevated.post("/blocklist", {"email": " " + BLOCKED.upper()})

    assert response.status_code == 201
    entry = BlockedSender.objects.get()
    assert entry.email_hash == contact.email_hash(BLOCKED)
    stored_row = json.dumps(list(BlockedSender.objects.values()), default=str)
    assert BLOCKED not in stored_row.lower()
    assert BLOCKED not in response.content.decode().lower()
    assert entry.expires_at.date() == blocklist.months_later(timezone.now(), 12).date()


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"email": "not an address"},
        {"email": "a@b.com\nBcc: c@d.com"},
        {"email": 5},
        {"email": BLOCKED, "note": "x" * 201},
        {"email": BLOCKED, "extra": 1},
        {"email": BLOCKED, "email_hash": "f" * 64},
    ],
)
def test_a_bad_add_is_refused(elevated, body):
    assert elevated.post("/blocklist", body).status_code == 400
    assert BlockedSender.objects.count() == 0


def test_blocking_the_same_address_twice_keeps_one_entry(elevated):
    first = elevated.post("/blocklist", {"email": BLOCKED}).json()
    second = elevated.post("/blocklist", {"email": BLOCKED.upper()}).json()

    assert first["id"] == second["id"]
    assert BlockedSender.objects.count() == 1


def test_blocking_from_a_message_moves_it_to_spam(elevated):
    message = new_message(email=BLOCKED, status="read")

    response = elevated.post(f"/messages/{message.id}/block", {"note": NOTE})

    assert response.status_code == 200
    message.refresh_from_db()
    assert message.status == ContactMessage.Status.SPAM
    assert message.spam_at is not None
    assert message.expires_at == message.spam_at + timedelta(days=30)
    entry = BlockedSender.objects.get()
    assert entry.email_hash == contact.email_hash(BLOCKED)
    assert entry.note == NOTE
    assert response.json()["entry"] == blocklist.describe(entry)
    assert submit(email=BLOCKED).json() == SENT
    assert ContactMessage.objects.count() == 1


def test_blocking_a_message_already_in_spam_keeps_its_spam_clock(elevated):
    then = timezone.now() - timedelta(days=3)
    message = new_message(email=BLOCKED, status="spam", spam_at=then)

    elevated.post(f"/messages/{message.id}/block", {})

    message.refresh_from_db()
    assert message.spam_at == then


def test_blocking_a_missing_message_is_not_found(elevated):
    response = elevated.post("/messages/00000000-0000-4000-8000-000000000000/block")

    assert response.status_code == 404
    assert BlockedSender.objects.count() == 0


def test_unblock_lets_the_sender_through_again(elevated):
    entry = block()

    response = elevated.post(f"/blocklist/{entry.id}/remove")

    assert response.status_code == 200
    assert BlockedSender.objects.count() == 0
    submit(email=BLOCKED)
    assert len(stored()) == 1
    assert elevated.post(f"/blocklist/{entry.id}/remove").status_code == 404


def test_renew_gives_a_new_lifetime_from_today(elevated):
    entry = block(expires_at=timezone.now() + timedelta(days=2))

    response = elevated.post(f"/blocklist/{entry.id}/renew")

    assert response.status_code == 200
    entry.refresh_from_db()
    assert entry.expires_at.date() == blocklist.months_later(timezone.now(), 12).date()
    assert response.json()["expires_at"] == entry.expires_at.isoformat()


def test_an_expired_entry_can_be_renewed_and_blocks_again(elevated):
    entry = block(expires_at=timezone.now() - timedelta(days=1))

    elevated.post(f"/blocklist/{entry.id}/renew")

    submit(email=BLOCKED)
    assert stored() == []


def test_renewing_a_missing_entry_is_not_found(elevated):
    missing = "00000000-0000-4000-8000-000000000000"

    assert elevated.post(f"/blocklist/{missing}/renew").status_code == 404


# Who may do what


CHANGES = [
    ("POST", "blocklist"),
    ("POST", "blocklist/<uuid:entry_id>/remove"),
    ("POST", "blocklist/<uuid:entry_id>/renew"),
    ("POST", "messages/<uuid:message_id>/block"),
]


def test_reading_needs_a_session_and_every_change_needs_elevation():
    views = {str(p.pattern): p.callback for p in admin_urls.urlpatterns}

    assert views["blocklist"].admin_levels == {
        "GET": Level.SESSION,
        "POST": Level.ELEVATED,
    }
    for method, path in CHANGES:
        assert views[path].admin_levels[method] is Level.ELEVATED


def test_a_session_alone_changes_nothing(signed_in):
    entry = block()
    message = new_message(email="other@example.org")
    before = entry.expires_at

    responses = [
        signed_in.post("/blocklist", {"email": "x@example.org"}),
        signed_in.post(f"/blocklist/{entry.id}/remove"),
        signed_in.post(f"/blocklist/{entry.id}/renew"),
        signed_in.post(f"/messages/{message.id}/block"),
    ]

    assert [r.status_code for r in responses] == [403] * 4
    assert {r.json()["code"] for r in responses} == {"elevation_required"}
    entry.refresh_from_db()
    assert entry.expires_at == before
    assert BlockedSender.objects.count() == 1
    message.refresh_from_db()
    assert message.status == "new"


def test_no_session_sees_nothing(api, passkey):
    block(note=NOTE)

    response = api.get("/blocklist")

    assert response.status_code == 401
    assert NOTE not in response.content.decode()


# The size cap


def fill(count, **fields):
    expires = fields.pop("expires_at", timezone.now() + timedelta(days=30))
    BlockedSender.objects.bulk_create(
        BlockedSender(email_hash=f"{n:064x}", expires_at=expires, **fields)
        for n in range(count)
    )


def test_the_list_holds_at_most_500_that_still_block(elevated):
    fill(499)
    assert elevated.post("/blocklist", {"email": BLOCKED}).status_code == 201

    response = elevated.post("/blocklist", {"email": "another@example.org"})

    assert response.status_code == 409
    assert response.json()["code"] == "blocklist_full"
    assert BlockedSender.objects.count() == 500


def test_a_full_list_refuses_a_block_from_a_message_and_leaves_it(elevated):
    fill(500)
    message = new_message(email=BLOCKED)

    response = elevated.post(f"/messages/{message.id}/block")

    assert response.status_code == 409
    message.refresh_from_db()
    assert message.status == "new"


def test_expired_entries_do_not_count_against_the_cap(elevated):
    fill(500, expires_at=timezone.now() - timedelta(days=1))

    assert elevated.post("/blocklist", {"email": BLOCKED}).status_code == 201


def test_a_full_list_still_renews_an_entry_that_blocks(elevated):
    fill(499)
    entry = block()

    assert elevated.post(f"/blocklist/{entry.id}/renew").status_code == 200


def test_a_full_list_refuses_to_bring_back_an_expired_entry(elevated):
    fill(500)
    entry = block(expires_at=timezone.now() - timedelta(days=1))

    assert elevated.post(f"/blocklist/{entry.id}/renew").status_code == 409


def test_the_cap_is_shown_as_a_fixed_limit(signed_in):
    rows = {r["name"]: r for r in signed_in.get("/limits").json()["fixed"]}

    assert rows["blocklist_max_entries"] == {
        "name": "blocklist_max_entries",
        "value": blocklist.MAX_ENTRIES,
        "unit": "count",
    }


# Lifetime


def test_the_lifetime_is_editable_from_1_to_36_months(elevated):
    editable = elevated.get("/limits").json()["editable"]["blocklist_months"]
    assert editable == {"value": 12, "default": 12, "min": 1, "max": 36}

    for bad in (0, 37, "6", 6.5, True):
        assert elevated.patch("/limits", {"blocklist_months": bad}).status_code == 400
    assert elevated.patch("/limits", {"blocklist_months": 3}).status_code == 200

    created = elevated.post("/blocklist", {"email": BLOCKED}).json()
    expected = blocklist.months_later(timezone.now(), 3).date().isoformat()
    assert created["expires_at"].startswith(expected)


def test_a_lifetime_change_is_audited_with_numbers_only(elevated):
    elevated.patch("/limits", {"blocklist_months": 24})

    (entry,) = AuditLog.objects.filter(event="limits_changed")
    assert entry.detail == {"changes": {"blocklist_months": {"old": 12, "new": 24}}}
    assert audit.verify_chain().ok


def test_changing_the_lifetime_needs_elevation(signed_in):
    assert signed_in.patch("/limits", {"blocklist_months": 2}).status_code == 403
    assert limits.effective()["blocklist_months"] == 12


@pytest.mark.parametrize(
    ("start", "months", "end"),
    [
        ("2026-01-31", 1, "2026-02-28"),
        ("2028-01-31", 1, "2028-02-29"),
        ("2026-11-24", 12, "2027-11-24"),
        ("2026-12-15", 1, "2027-01-15"),
        ("2026-03-31", 36, "2029-03-31"),
    ],
)
def test_months_are_calendar_months(start, months, end):
    from datetime import datetime

    begin = datetime.fromisoformat(start + "T12:00:00+00:00")

    assert blocklist.months_later(begin, months).date().isoformat() == end


# The daily job


def test_the_job_deletes_expired_entries_and_counts_them():
    gone = block(expires_at=timezone.now() - timedelta(minutes=1))
    kept = block(email="other@example.org")

    counts = retention.run()

    assert counts["blocklist_deleted"] == 1
    assert set(BlockedSender.objects.values_list("id", flat=True)) == {kept.id}
    (entry,) = AuditLog.objects.filter(event="retention_run")
    assert entry.detail["blocklist_deleted"] == 1
    assert str(gone.id) not in json.dumps(entry.detail)


def test_a_renewed_entry_survives_the_job(elevated):
    entry = block(expires_at=timezone.now() + timedelta(minutes=1))
    elevated.post(f"/blocklist/{entry.id}/renew")
    BlockedSender.objects.filter(id=entry.id).update(
        expires_at=timezone.now() + timedelta(days=1)
    )

    retention.run()

    assert BlockedSender.objects.filter(id=entry.id).exists()


def test_a_dry_run_counts_expired_entries_and_deletes_none():
    block(expires_at=timezone.now() - timedelta(minutes=1))

    counts = retention.run(dry_run=True)

    assert counts["blocklist_deleted"] == 1
    assert BlockedSender.objects.count() == 1


# Audit


def test_block_changes_are_audited_with_ids_only(elevated):
    elevated.post("/blocklist", {"email": BLOCKED, "note": NOTE})
    entry = BlockedSender.objects.get()
    elevated.post(f"/blocklist/{entry.id}/renew")
    elevated.post(f"/blocklist/{entry.id}/remove")
    message = new_message(email="other@example.org", body="A private body here.")
    elevated.post(f"/messages/{message.id}/block")

    events = [e.event for e in AuditLog.objects.order_by("seq")]
    for event in ("sender_blocked", "sender_block_renewed", "sender_unblocked"):
        assert event in events
    assert "message_sender_blocked" in events
    said = json.dumps(list(AuditLog.objects.values("event", "detail")))
    for secret in (BLOCKED, "other@example.org", NOTE, "A private body here."):
        assert secret not in said
    assert contact.email_hash(BLOCKED) not in said
    assert contact.email_hash("other@example.org") not in said
    assert audit.verify_chain().ok


# Migration 0018


def test_0018_adds_the_list_and_the_lifetime_and_reverses(at_latest):  # noqa: F811
    from tests.test_contact_migrations import columns, migrate, tables

    migrate([("core", "0017_contact_limits")])
    assert "blocked_senders" not in tables()
    assert "blocklist_months" not in columns("site_settings")

    migrate([("core", "0018_blocklist")])

    assert "blocked_senders" in tables()
    assert columns("blocked_senders") == {
        "id",
        "email_hash",
        "note",
        "created_at",
        "expires_at",
    }
    assert "blocklist_months" in columns("site_settings")
