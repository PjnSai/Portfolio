"""Daily caps: one for messages that are not spam, one for stored spam. The
spam decision comes first, then the cap that applies. The per-email and
per-address limits count every attempt, spam or not."""

import logging

import pytest

from tests import turnstile as fake
from tests.test_contact import SENT, stored, submit

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def fresh_stand_in():
    fake.spent.clear()
    fake.asked.clear()


def ip(n):
    # Each address may send 5 an hour, so a run past that spreads them out.
    return f"198.51.100.{n}"


def human(n, **fields):
    return submit(ip=ip(n), **fields)


def spam(n, **fields):
    return submit(ip=ip(n), website="x", **fields)


def kinds():
    return [m.status == "spam" for m in stored()]


def test_the_default_caps():
    from django.conf import settings

    assert settings.CONTACT_DAILY_CAP == 25
    assert settings.CONTACT_SPAM_DAILY_CAP == 20


def test_twenty_five_messages_a_day_then_the_next_is_refused():
    assert [human(n).status_code for n in range(25)] == [201] * 25

    response = human(30)

    assert response.status_code == 429
    assert int(response["Retry-After"]) >= 1
    assert response.json()["code"] == "rate_limited"
    assert len(stored()) == 25


def test_spam_does_not_use_up_the_twenty_five():
    assert [spam(n).status_code for n in range(20)] == [201] * 20

    assert [human(n + 100).status_code for n in range(25)] == [201] * 25
    assert human(200).status_code == 429
    assert kinds().count(True) == 20
    assert kinds().count(False) == 25


def test_the_spam_cap_stops_storing_but_still_answers_received(caplog):
    caplog.set_level(logging.INFO)
    for n in range(20):
        spam(n)

    response = spam(50)

    assert response.status_code == 201
    assert response.json() == SENT
    assert len(stored()) == 20
    assert "outcome=spam_dropped" in caplog.text
    dropped = [r.getMessage() for r in caplog.records if "spam_dropped" in r.message]
    assert dropped == ["contact outcome=spam_dropped"]


def test_a_dropped_spam_answer_looks_like_any_other(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 0
    dropped = spam(1)
    kept = human(2)

    assert (dropped.status_code, dropped.json()) == (kept.status_code, kept.json())
    assert dropped["Cache-Control"] == kept["Cache-Control"]
    assert dropped.get("Retry-After") is None


def test_a_message_that_is_not_spam_is_accepted_after_much_spam():
    for n in range(40):
        assert spam(n).status_code == 201

    response = human(99)

    assert response.status_code == 201
    assert kinds() == [True] * 20 + [False]


def test_each_spam_reason_counts_against_the_spam_cap(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 2
    submit(ip=ip(1), age=0)
    submit(ip=ip(2), body="Look at http://a.test http://b.test http://c.test now")

    spam(3)

    assert len(stored()) == 2


def test_the_spam_cap_can_be_set_to_store_no_spam(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 0

    assert spam(1).status_code == 201

    assert stored() == []


# The per-email and per-address limits are unchanged and count every attempt


def test_the_address_limit_counts_spam_that_was_not_stored(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 0
    for _ in range(5):
        assert submit(ip=ip(7), website="x").status_code == 201

    assert submit(ip=ip(7)).status_code == 429
    assert submit(ip=ip(8)).status_code == 201


def test_the_email_limit_counts_spam_that_was_not_stored(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 0
    for n in range(3):
        spam(n, email="bot@example.com")

    assert human(9, email="bot@example.com").status_code == 429
    assert human(10, email="person@example.com").status_code == 201


def test_the_address_limit_still_comes_before_the_caps():
    for _ in range(5):
        submit(ip=ip(1))

    assert submit(ip=ip(1)).status_code == 429
    assert len(stored()) == 5


def test_the_email_limit_still_applies_below_the_caps():
    for n in range(3):
        assert human(n, email="same@example.com").status_code == 201

    assert human(5, email="same@example.com").status_code == 429


# A message refused by a cap does not leave its body's marker behind

TEXT = "Hello, I would like to ask about the project you wrote up last year."


def test_a_message_refused_by_the_daily_cap_is_not_a_repeat_later(settings):
    settings.CONTACT_DAILY_CAP = 1
    human(1)
    assert human(2, body=TEXT).status_code == 429
    settings.CONTACT_DAILY_CAP = 5

    assert human(3, body=TEXT).status_code == 201

    assert stored()[-1].status == "new"


def test_spam_dropped_by_the_spam_cap_is_not_a_repeat_later(settings):
    settings.CONTACT_SPAM_DAILY_CAP = 0
    assert submit(ip=ip(1), age=0, body=TEXT).status_code == 201
    assert stored() == []

    human(2, body=TEXT)

    assert [m.status for m in stored()] == ["new"]


def test_a_dropped_repeat_keeps_the_marker_of_the_message_stored_before(settings):
    human(1, body=TEXT)
    settings.CONTACT_SPAM_DAILY_CAP = 0
    assert human(2, body=TEXT).status_code == 201
    settings.CONTACT_SPAM_DAILY_CAP = 20

    human(3, body=TEXT)

    assert [m.status for m in stored()] == ["new", "spam"]
