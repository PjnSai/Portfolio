"""The spam retention period runs from when a message became spam (spam_at),
not from when it arrived. Migration 0016 adds the column."""

from datetime import timedelta

import pytest
from django.utils import timezone

from core import retention
from tests.test_contact import stored, submit
from tests.test_contact_migrations import at_latest, columns, migrate, settle  # noqa: F401
from tests.test_inbox import make

pytestmark = pytest.mark.django_db

DAY = timedelta(days=1)


def close(a, b, within=timedelta(seconds=30)):
    return abs(a - b) <= within


def test_a_message_that_arrives_as_spam_is_spam_from_its_arrival():
    submit(website="x")

    (message,) = stored()
    assert message.status == "spam"
    assert message.spam_at == message.created_at
    assert message.expires_at == message.spam_at + timedelta(days=30)


def test_a_message_that_arrives_clean_has_no_spam_time():
    submit()

    (message,) = stored()
    assert message.spam_at is None


def test_an_old_message_marked_spam_today_expires_thirty_days_from_today(signed_in):
    old = make("read", created_at=timezone.now() - 300 * DAY)

    response = signed_in.post(f"/messages/{old.id}/status", {"status": "spam"})

    assert response.status_code == 200
    old.refresh_from_db()
    assert close(old.spam_at, timezone.now())
    assert old.expires_at == old.spam_at + timedelta(days=30)
    assert old.expires_at > timezone.now() + 29 * DAY


def test_marking_spam_uses_the_owners_spam_period(signed_in):
    retention.save(9, 400)
    old = make("archived", created_at=timezone.now() - 500 * DAY)

    signed_in.post(f"/messages/{old.id}/status", {"status": "spam"})

    old.refresh_from_db()
    assert old.expires_at == old.spam_at + timedelta(days=9)


def test_not_spam_clears_the_spam_time_and_restores_twelve_months(signed_in):
    old = make("read", created_at=timezone.now() - 20 * DAY)
    signed_in.post(f"/messages/{old.id}/status", {"status": "spam"})

    response = signed_in.post(f"/messages/{old.id}/not-spam")

    assert response.status_code == 200
    old.refresh_from_db()
    assert old.spam_at is None
    assert old.status == "new"
    assert old.expires_at == old.created_at + timedelta(days=365)


def test_marking_spam_again_restarts_the_spam_clock(signed_in):
    old = make("read", created_at=timezone.now() - 100 * DAY)
    signed_in.post(f"/messages/{old.id}/status", {"status": "spam"})
    old.refresh_from_db()
    first = old.spam_at
    signed_in.post(f"/messages/{old.id}/not-spam")

    signed_in.post(f"/messages/{old.id}/status", {"status": "spam"})

    old.refresh_from_db()
    assert old.spam_at >= first
    assert old.expires_at == old.spam_at + timedelta(days=30)


def test_changing_the_periods_counts_spam_from_its_spam_time():
    now = timezone.now()
    marked = make("spam", created_at=now - 200 * DAY, spam_at=now - 5 * DAY)
    arrived = make("spam", created_at=now - 3 * DAY, spam_at=now - 3 * DAY)
    other = make("read", created_at=now - 200 * DAY)

    retention.save(10, 400)

    for row in (marked, arrived, other):
        row.refresh_from_db()
    assert marked.expires_at == marked.spam_at + timedelta(days=10)
    assert arrived.expires_at == arrived.spam_at + timedelta(days=10)
    assert other.expires_at == other.created_at + timedelta(days=400)


def test_spam_with_no_spam_time_falls_back_to_its_arrival():
    old = make("spam", created_at=timezone.now() - 2 * DAY, spam_at=None)

    retention.save(12, 365)

    old.refresh_from_db()
    assert old.expires_at == old.created_at + timedelta(days=12)


def test_the_detail_view_shows_the_new_expiry(signed_in):
    old = make("read", created_at=timezone.now() - 300 * DAY)

    body = signed_in.post(f"/messages/{old.id}/status", {"status": "spam"}).json()

    old.refresh_from_db()
    assert body["expires_at"] == old.expires_at.isoformat()


# Migration 0016

BEFORE = [("core", "0015_drop_old_messages")]
AFTER = [("core", "0016_contact_spam_at")]


def test_0016_backfills_spam_from_its_arrival_and_reverses(at_latest):  # noqa: F811
    apps = migrate(BEFORE)
    message = apps.get_model("core", "ContactMessage")
    arrived = timezone.now() - 10 * DAY
    spam = message.objects.create(
        name="A",
        email="a@example.com",
        body="Cheap watches here.",
        status="spam",
        created_at=arrived,
        expires_at=arrived + timedelta(days=30),
    )
    clean = message.objects.create(
        name="B",
        email="b@example.com",
        body="Hello there, a message.",
        status="read",
        created_at=arrived,
        expires_at=arrived + timedelta(days=365),
    )
    settle()
    assert "spam_at" not in columns("contact_messages")

    apps = migrate(AFTER)

    message = apps.get_model("core", "ContactMessage")
    assert message.objects.get(id=spam.id).spam_at == arrived
    assert message.objects.get(id=clean.id).spam_at is None
    assert message.objects.get(id=spam.id).expires_at == arrived + timedelta(days=30)
    settle()

    apps = migrate(BEFORE)

    assert "spam_at" not in columns("contact_messages")
    message = apps.get_model("core", "ContactMessage")
    assert message.objects.get(id=spam.id).status == "spam"
