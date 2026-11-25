"""Asking for a copy of the CV: the contact form's pipeline, a message marked
as a CV request in the inbox, and nothing sent by the site."""

import json
from datetime import timedelta

import pytest
import redis
from django.db import OperationalError
from django.test import Client
from django.utils import timezone

from core import cache, contact, erase, retention
from core.models import BlockedSender, ContactMessage, SiteSettings
from tests.conftest import ORIGIN
from tests.notifiers import Recorder
from tests.turnstile import PASSES

pytestmark = pytest.mark.django_db

URL = "/api/v1/cv/request"
SENT = {"detail": "Thank you. Your message has been received."}
ADDRESS = "203.0.113.7"
_counter = iter(range(1, 10**6))


def token():
    return f"{PASSES}#req{next(_counter)}"


def good(**overrides):
    n = next(_counter)
    body = {
        "name": "Sam Recruiter",
        "email": f"sam{n}@example.com",
        "note": f"For the graduate role, reference {n}.",
        "website": "",
        "elapsed": 30_000,
        "turnstile": token(),
    }
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not None}


def send(body=None, ip=ADDRESS, raw=None, **headers):
    return Client(enforce_csrf_checks=True).post(
        URL,
        raw if raw is not None else json.dumps(body if body is not None else good()),
        content_type="application/json",
        secure=True,
        headers={
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-site",
            "Cf-Connecting-Ip": ip,
            **headers,
        },
    )


def stored():
    return list(ContactMessage.objects.order_by("created_at"))


def test_a_request_is_received_and_lands_in_the_inbox_marked(signed_in):
    response = send(good(email="sam@example.com", note="For the graduate role."))

    assert response.status_code == 201
    assert response.json() == SENT
    (message,) = stored()
    assert message.kind == ContactMessage.Kind.CV_REQUEST
    assert message.email == "sam@example.com"
    assert message.name == "Sam Recruiter"
    assert message.status == ContactMessage.Status.NEW
    assert message.body == (
        "Request for a copy of the CV.\n\nNote from the sender:\nFor the graduate role."
    )
    listed = signed_in.get("/messages").json()["results"]
    assert [(m["id"], m["kind"]) for m in listed] == [(str(message.id), "cv_request")]
    assert signed_in.get(f"/messages/{message.id}").json()["kind"] == "cv_request"


def test_the_answer_is_the_same_as_the_contact_form():
    assert send().json() == SENT
    assert send()["Cache-Control"] == "no-store"


def test_the_name_and_note_are_optional():
    response = send(good(name=None, note=None))

    assert response.status_code == 201
    (message,) = stored()
    assert message.name == ""
    assert message.body == "Request for a copy of the CV."


def test_an_empty_name_and_note_are_the_same_as_none():
    assert send(good(name="  ", note="")).status_code == 201
    assert stored()[0].body == "Request for a copy of the CV."


def test_the_site_sends_no_email():
    send()

    assert Recorder.sent == []


def test_the_inbox_can_be_filtered_to_cv_requests(signed_in):
    from tests.conftest import new_message

    plain = new_message()
    send()
    request = ContactMessage.objects.get(kind="cv_request")

    only_requests = signed_in.get("/messages", {"kind": "cv_request"}).json()
    only_messages = signed_in.get("/messages", {"kind": "message"}).json()

    assert [m["id"] for m in only_requests["results"]] == [str(request.id)]
    assert [m["id"] for m in only_messages["results"]] == [str(plain.id)]
    assert signed_in.get("/messages", {"kind": "other"}).status_code == 400


def test_a_request_from_a_blocked_sender_is_answered_and_not_stored():
    from core import blocklist

    blocklist.block_email("blocked@example.com")

    response = send(good(email="Blocked@Example.com"))

    assert response.status_code == 201
    assert response.json() == SENT
    assert stored() == []
    assert BlockedSender.objects.get().hit_count == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", "Sam\r\nBcc: victim@example.com"),
        ("name", "Sam\nTo: victim@example.com"),
        ("name", "Sam Cc: victim@example.com"),
        ("email", "sam@example.com\r\nBcc: victim@example.com"),
        ("email", "sam@example.com\nBcc: victim@example.com"),
        ("email", "sam@example.com, victim@example.com"),
        ("email", '"Sam" <sam@example.com>'),
        ("email", "not an email"),
        ("email", ""),
        ("name", "x" * 101),
        ("note", "x" * 501),
        ("name", 5),
        ("note", ["a"]),
    ],
)
def test_injection_and_bad_values_are_refused(field, value):
    response = send(good(**{field: value}))

    assert response.status_code == 400
    assert field in response.json()["errors"]
    assert stored() == []


def test_the_email_is_required():
    body = good()
    del body["email"]

    response = send(body)

    assert response.status_code == 400
    assert "email" in response.json()["errors"]


def test_line_breaks_in_the_note_never_carry_a_header():
    send(good(note="Line one\r\nBcc: victim@example.com\rmore end"))

    body = stored()[0].body
    assert "\r" not in body
    assert " " not in body
    assert body.endswith("Line one\nBcc: victim@example.com\nmore\nend")


def test_hidden_characters_are_removed():
    send(good(name="Sam‮​ Recruiter", note="Hi\x00 there⁦"))

    message = stored()[0]
    assert message.name == "Sam Recruiter"
    assert message.body.endswith("Hi there")


@pytest.mark.parametrize(
    "overrides,code",
    [
        ({"website": "http://spam.test"}, "honeypot"),
        ({"elapsed": 500}, "timing"),
        (
            {"note": "http://a.test http://b.test http://c.test http://d.test"},
            "links",
        ),
        ({"note": "casino forex lottery http://a.test http://b.test"}, "score"),
    ],
)
def test_spam_is_quarantined_and_answered_the_same(overrides, code):
    response = send(good(**overrides))

    assert response.json() == SENT
    (message,) = stored()
    assert message.status == ContactMessage.Status.SPAM
    assert message.spam_at is not None
    assert message.kind == ContactMessage.Kind.CV_REQUEST


def test_two_people_asking_with_no_note_are_not_taken_for_a_repeat():
    send(good(note=None, email="one@example.com"))
    send(good(note=None, email="two@example.com"))

    assert [m.status for m in stored()] == ["new", "new"]


def test_the_same_person_asking_twice_in_a_day_is_quarantined():
    send(good(note=None, email="one@example.com"))
    send(good(note=None, email="ONE@example.com"))

    assert [m.status for m in stored()] == ["new", "spam"]


def test_turnstile_failing_stores_nothing():
    response = send(good(turnstile="wrong"))

    assert response.status_code == 400
    assert response.json()["code"] == "challenge"
    assert stored() == []


def test_turnstile_being_unavailable_stores_nothing():
    response = send(good(turnstile="unavailable"))

    assert response.status_code == 503
    assert stored() == []


def test_a_missing_turnstile_token_stores_nothing():
    body = good()
    del body["turnstile"]

    assert send(body).status_code == 400
    assert stored() == []


def test_the_database_failing_stores_nothing_and_answers_503(monkeypatch):
    def down(*args, **kwargs):
        raise OperationalError("down")

    monkeypatch.setattr(contact, "store", down)

    response = send()

    assert response.status_code == 503
    assert stored() == []


def test_the_database_failing_on_the_switch_answers_503(monkeypatch):
    from core import cv

    def down(*args, **kwargs):
        raise OperationalError("down")

    monkeypatch.setattr(cv, "switches", down)

    assert send().status_code == 503
    assert stored() == []


def test_redis_failing_stores_nothing_and_answers_503(monkeypatch):
    def down():
        raise redis.ConnectionError("down")

    monkeypatch.setattr(cache, "client", down)

    assert send().status_code == 503
    assert stored() == []


def test_requests_are_refused_when_the_switch_is_off():
    SiteSettings.objects.create(cv_request_enabled=False)

    response = send()

    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden."}
    assert stored() == []


def test_requests_do_not_need_a_live_cv():
    assert send().status_code == 201


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "[]",
        "not json",
        json.dumps({**good(), "body": "a message"}),
        json.dumps({**good(), "reason": "hiring"}),
    ],
)
def test_malformed_requests_are_refused(raw):
    assert send(raw=raw).status_code == 400
    assert stored() == []


def test_a_request_needs_the_site_origin():
    response = send(Origin="https://evil.test", **{"Sec-Fetch-Site": "cross-site"})

    assert response.status_code == 403
    assert stored() == []


# Limits: shared with the contact form


def contact_message(email, ip=ADDRESS):
    return Client().post(
        "/api/v1/contact",
        json.dumps(
            {
                "name": "Sam",
                "email": email,
                "body": f"Hello there, this is a message {next(_counter)}.",
                "website": "",
                "elapsed": 30_000,
                "turnstile": token(),
            }
        ),
        content_type="application/json",
        secure=True,
        headers={
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-site",
            "Cf-Connecting-Ip": ip,
        },
    )


def test_requests_and_messages_share_the_per_address_limit(settings):
    for n in range(settings.CONTACT_PER_ADDRESS_PER_HOUR - 1):
        assert contact_message(f"m{n}@example.com").status_code == 201
    assert send().status_code == 201

    response = send()

    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


def test_requests_and_messages_share_the_per_email_limit(settings):
    for _ in range(settings.CONTACT_PER_EMAIL_PER_DAY - 1):
        contact_message("same@example.com", ip=f"198.51.100.{next(_counter) % 200}")
    assert send(good(email="same@example.com", note="first")).status_code == 201

    response = send(good(email="same@example.com", note="second"), ip="192.0.2.1")

    assert response.status_code == 429


def test_requests_count_against_the_inbox_daily_cap(settings):
    settings.CONTACT_DAILY_CAP = 1
    assert contact_message("m@example.com", ip="198.51.100.1").status_code == 201

    response = send(ip="198.51.100.2")

    assert response.status_code == 429
    assert ContactMessage.objects.filter(kind="cv_request").count() == 0


# Retention and delete-everything treat it like any message


def test_a_request_expires_like_any_message():
    send()
    message = stored()[0]
    spam_days, message_days = retention.periods()

    assert message.expires_at == message.created_at + timedelta(days=message_days)

    ContactMessage.objects.update(expires_at=timezone.now() - timedelta(days=1))
    assert retention.run()["deleted"] == 1
    assert stored() == []


def test_delete_everything_removes_requests_too():
    send(good(email="sam@example.com"))
    send(good(email="sam@example.com", note="Again"), ip="198.51.100.2")
    from tests.conftest import new_message

    new_message(email="sam@example.com")
    other = new_message(email="other@example.com")

    result = erase.run(
        {"email_hash": contact.email_hash("sam@example.com"), "also_block": False}
    )

    assert result["messages"] == 3
    assert [m.id for m in stored()] == [other.id]


def test_a_request_can_be_replied_to_and_noted_like_any_message(signed_in):
    send()
    message = stored()[0]

    detail = signed_in.get(f"/messages/{message.id}").json()
    assert detail["email"] == message.email
    noted = signed_in.post(f"/messages/{message.id}/responded", {"text": "Sent"})
    assert noted.status_code == 201
    assert signed_in.get(f"/messages/{message.id}").json()["status"] == "replied"
