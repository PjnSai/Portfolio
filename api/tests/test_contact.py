"""The public contact form: Turnstile, validation, bot checks, limits, logs."""

import hashlib
import json
import logging
from datetime import timedelta

import pytest
import redis
from django.db import OperationalError
from django.test import Client
from django.utils import timezone

from core import cache, contact
from core.models import ContactMessage
from tests import turnstile as fake
from tests.conftest import ORIGIN
from tests.turnstile import PASSES

pytestmark = pytest.mark.django_db

URL = "/api/v1/contact"
SENT = {"detail": "Thank you. Your message has been received."}

NAME = "Sam Recruiter"
BODY = "Hello, I would like to talk to you about a role at our company."
ADDRESS = "203.0.113.7"
_counter = iter(range(1, 10**6))


def visitor():
    # The route takes no cookie, so there is no CSRF token to check.
    return Client(enforce_csrf_checks=True)


def token():
    """A Turnstile token the stand-in accepts once (see tests/turnstile.py)."""
    return f"{PASSES}#{next(_counter)}"


def good(client=None, ip=ADDRESS, age=30, **overrides):
    """A complete, valid submission: a Turnstile token and a form opened `age`
    seconds ago. Each call gets its own email and body unless overridden."""
    n = next(_counter)
    body = {
        "name": NAME,
        "email": f"sam{n}@example.com",
        "body": f"{BODY} Reference {n}.",
        "website": "",
        "elapsed": int(age * 1000),
        "turnstile": token(),
    }
    body.update(overrides)
    return body


def send(client, body, ip=ADDRESS, raw=None, content_type="application/json"):
    data = raw if raw is not None else json.dumps(body)
    return client.post(
        URL,
        data,
        content_type=content_type,
        secure=True,
        headers={
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-site",
            "Cf-Connecting-Ip": ip,
        },
    )


def submit(ip=ADDRESS, age=30, **overrides):
    client = visitor()
    return send(client, good(client, ip, age, **overrides), ip)


def stored():
    return list(ContactMessage.objects.order_by("created_at"))


def redis_down(monkeypatch):
    def down():
        raise redis.ConnectionError("down")

    monkeypatch.setattr(cache, "client", down)


def database_down(monkeypatch):
    def down(*args, **kwargs):
        raise OperationalError("down")

    monkeypatch.setattr(ContactMessage, "save", down)


# Turnstile's stand-in is reset for every test


@pytest.fixture(autouse=True)
def fresh_stand_in():
    fake.spent.clear()
    fake.asked.clear()


# A good message


def test_a_good_message_is_stored_as_new():
    response = submit()

    assert response.status_code == 201
    assert response.json() == SENT
    assert response["Cache-Control"] == "no-store"
    (message,) = stored()
    assert message.status == "new"
    assert message.name == NAME
    assert message.email.endswith("@example.com")
    assert message.body.startswith(BODY)
    assert message.kept is False
    assert message.read_at is None


def test_the_address_is_stored_only_as_a_keyed_hash():
    submit(ip=ADDRESS)

    (message,) = stored()
    assert len(message.ip_hash) == 64
    assert ADDRESS not in message.ip_hash
    assert message.ip_hash == contact.address_hash(ADDRESS)
    assert message.ip_hash != hashlib.sha256(ADDRESS.encode()).hexdigest()
    assert message.ip_hash != contact.address_hash("203.0.113.8")


def test_a_message_is_kept_for_twelve_months_by_default():
    submit()

    (message,) = stored()
    assert message.expires_at - message.created_at == timedelta(days=365)


def test_spam_is_kept_for_thirty_days_by_default():
    submit(website="x")

    (message,) = stored()
    assert message.status == "spam"
    assert message.expires_at - message.created_at == timedelta(days=30)


def test_the_owners_saved_periods_are_used():
    from core import retention

    retention.save(10, 100)
    submit()
    submit(website="x")

    normal, spam = stored()
    assert normal.expires_at - normal.created_at == timedelta(days=100)
    assert spam.expires_at - spam.created_at == timedelta(days=10)


def test_a_public_message_never_creates_the_settings_row():
    from core.models import SiteSettings

    submit()

    assert not SiteSettings.objects.exists()


# The reason and the spam score


@pytest.mark.parametrize("reason", ["hiring", "project", "other", ""])
def test_the_reason_is_stored(reason):
    assert submit(reason=reason).status_code == 201

    assert stored()[0].reason == reason


def test_the_reason_is_optional():
    client = visitor()
    body = good(client)

    assert send(client, body).status_code == 201
    assert stored()[0].reason == ""


@pytest.mark.parametrize(
    "reason",
    ["Hiring", "spam", "hiring,project", " hiring", None, 1, ["hiring"], "x" * 50],
)
def test_any_other_reason_is_refused(reason):
    assert invalid(reason=reason)["errors"]["reason"]


def test_a_plain_message_scores_nothing():
    submit()

    assert stored()[0].spam_score == 0


def test_each_link_adds_a_little():
    submit(body="My site is https://a.example and my repo http://b.example thanks.")

    message = stored()[0]
    assert (message.status, message.spam_score) == ("new", 40)


def test_keywords_add_points_but_never_quarantine_alone():
    submit(body="Casino and viagra and backlinks and forex, all for your site.")

    message = stored()[0]
    assert (message.status, message.spam_score) == ("new", 75)


def test_points_from_links_and_keywords_can_add_up_to_quarantine():
    submit(
        body="Casino viagra backlinks, see https://a.example and https://b.example now."
    )

    message = stored()[0]
    assert (message.status, message.spam_score) == ("spam", 100)


@pytest.mark.parametrize(
    "overrides",
    [
        {"website": "x"},
        {"age": 1},
        {"body": "https://a.example https://b.example https://c.example"},
    ],
)
def test_a_failed_check_scores_the_full_hundred(overrides):
    submit(**overrides)

    message = stored()[0]
    assert (message.status, message.spam_score) == ("spam", 100)


def test_the_score_is_never_above_a_hundred():
    submit(website="x", age=0, body="casino viagra backlinks https://a.example " * 3)

    assert stored()[0].spam_score == 100


def test_the_form_is_refused_from_another_origin():
    client = visitor()
    body = good(client)

    response = client.post(
        URL,
        json.dumps(body),
        content_type="application/json",
        secure=True,
        headers={"Origin": "https://evil.test", "Sec-Fetch-Site": "cross-site"},
    )

    assert response.status_code == 403
    assert stored() == []


def test_only_post_is_allowed():
    response = visitor().get(URL, secure=True)

    assert response.status_code == 405


# Validation and injection


def invalid(**overrides):
    response = submit(**overrides)
    assert response.status_code == 400, response.content
    assert stored() == []
    return response.json()


@pytest.mark.parametrize("field", ["name", "email", "body"])
def test_required_fields(field):
    client = visitor()
    body = good(client)
    del body[field]

    response = send(client, body)

    assert response.status_code == 400
    assert field in response.json()["errors"]


@pytest.mark.parametrize("field", ["name", "email", "body"])
@pytest.mark.parametrize("value", [None, 5, ["a"], {"a": 1}, True])
def test_fields_must_be_text(field, value):
    assert invalid(**{field: value})["errors"][field]


def test_unknown_fields_are_refused_not_ignored():
    client = visitor()
    body = good(client, status="read", kept=True, id="x")

    response = send(client, body)

    assert response.status_code == 400
    assert stored() == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "x" * 101},
        {"name": "   "},
        {"email": "x" * 250 + "@example.com"},
        {"body": "short"},
        {"body": "x" * 4001},
    ],
)
def test_length_limits(overrides):
    (field,) = overrides
    assert invalid(**overrides)["errors"][field]


def test_limits_are_inclusive():
    assert submit(name="x" * 100, body="y" * 4000).status_code == 201
    assert submit(body="y" * 10).status_code == 201


@pytest.mark.parametrize(
    "email",
    [
        "not-an-email",
        "a@b",
        "a b@example.com",
        "<a@example.com>",
        "a@example.com,b@example.com",
        "a@example.com;b@example.com",
        '"a b"@example.com',
        "a@@example.com",
        "@example.com",
        "a@example.com\nBcc: x@example.com",
        "a@example.com\r\nBcc: x@example.com",
        "a@example.com x",
    ],
)
def test_email_format_and_header_injection(email):
    assert invalid(email=email)["errors"]["email"]


@pytest.mark.parametrize("field", ["name", "email"])
@pytest.mark.parametrize("breaker", ["\n", "\r", "\r\n", " ", " ", "\x85"])
def test_new_lines_are_rejected_in_name_and_email(field, breaker):
    value = f"a{breaker}b@example.com" if field == "email" else f"Sam{breaker}Smith"

    assert invalid(**{field: value})["errors"][field]


def test_control_characters_are_stripped():
    submit(
        name="Sam\x00 Smi\x07th",
        email="sam\x00@example.com",
        body="Hello\x00 there\x1b[31m, this is\x7f fine.‮ Really​.",
    )

    (message,) = stored()
    assert message.name == "Sam Smith"
    assert message.email == "sam@example.com"
    assert message.body == "Hello there[31m, this is fine. Really."


def test_new_lines_in_the_message_are_kept_and_normalised():
    submit(body="First line of the message.\r\nSecond line.\rThird line.\tTabbed")

    (message,) = stored()
    assert message.body == (
        "First line of the message.\nSecond line.\nThird line. Tabbed"
    )


@pytest.mark.parametrize(
    "payload",
    [
        "'; DROP TABLE contact_messages; --",
        "' OR '1'='1",
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(1)">',
        "{{7*7}} ${7*7} %s %(x)s",
        "javascript:alert(1)",
    ],
)
def test_injection_text_is_kept_as_plain_text(payload):
    body = f"{payload} and then some more words"
    assert submit(body=body, name=payload[:100]).status_code == 201

    (message,) = stored()
    assert message.body == body
    assert message.name == payload[:100]
    assert ContactMessage.objects.count() == 1


@pytest.mark.parametrize(
    "raw", ["", "not json", "[]", '"text"', "null", "5", '{"name": ']
)
def test_bad_bodies_are_refused(raw):
    response = send(visitor(), None, raw=raw)

    assert response.status_code == 400
    assert stored() == []


def test_the_content_type_must_be_json():
    client = visitor()
    body = good(client)

    response = send(client, body, content_type="text/plain")

    assert response.status_code == 400


def test_a_large_body_is_refused_before_it_is_read():
    response = send(visitor(), None, raw=json.dumps({"body": "x" * 30_000}))

    assert response.status_code == 413


# Bot checks: each is saved as spam and looks the same as a success


def assert_quarantined(response, reference):
    assert response.status_code == reference.status_code
    assert response.content == reference.content
    assert dict(response.headers) == dict(reference.headers)
    assert stored()[-1].status == "spam"


def reference_success():
    """What a real message gets, from another address so limits do not mix."""
    response = submit(ip="198.51.100.1")
    ContactMessage.objects.all().delete()
    cache.client().flushdb()
    return response


def test_a_filled_honeypot_is_quarantined():
    reference = reference_success()

    response = submit(website="http://spam.example")

    assert_quarantined(response, reference)


def test_a_form_sent_in_under_three_seconds_is_quarantined():
    reference = reference_success()

    response = submit(age=1)

    assert_quarantined(response, reference)


def test_a_form_sent_after_three_seconds_is_not():
    assert submit(age=4).status_code == 201

    assert stored()[0].status == "new"


def test_too_many_links_are_quarantined():
    reference = reference_success()
    links = "See https://a.example and http://b.example and www.c.example now."

    response = submit(body=links)

    assert_quarantined(response, reference)


def test_two_links_are_fine():
    submit(body="My site is https://a.example and my repo http://b.example thanks.")

    assert stored()[0].status == "new"


def test_a_repeated_message_is_quarantined():
    reference = reference_success()
    text = "Please buy my product today, it is very good and cheap."
    assert submit(body=text, email="one@example.com").status_code == 201

    response = submit(body="  " + text.upper() + "\n", email="two@example.com")

    assert_quarantined(response, reference)
    assert [m.status for m in stored()] == ["new", "spam"]


def test_a_quarantined_message_keeps_the_same_fields_for_review():
    submit(website="x")

    (message,) = stored()
    assert message.status == "spam"
    assert message.name == NAME
    assert message.ip_hash == contact.address_hash(ADDRESS)
    assert message.expires_at > timezone.now()


# Turnstile and the form token


BAD = {
    "detail": "The anti-spam check did not pass. Please try again.",
    "code": "challenge",
}


def assert_bad_challenge(response):
    assert response.status_code == 400, response.content
    assert response.json() == BAD
    assert stored() == []


def test_a_good_token_is_checked_with_cloudflare_once():
    good_token = token()

    assert submit(turnstile=good_token).status_code == 201

    assert fake.asked == [good_token]


@pytest.mark.parametrize(
    "value", ["", "wrong", "XXXX", None, 5, ["a"], {"a": 1}, True, "x" * 2049]
)
def test_a_token_cloudflare_refuses_or_in_the_wrong_shape_is_refused(value):
    assert_bad_challenge(submit(turnstile=value))


def test_a_missing_token_is_refused():
    client = visitor()
    body = good(client)
    del body["turnstile"]

    assert_bad_challenge(send(client, body))


def test_a_token_works_once():
    spent = token()
    assert submit(turnstile=spent).status_code == 201

    assert len(stored()) == 1
    replay = submit(turnstile=spent, email="other@example.com", body=BODY + " 2")

    assert replay.status_code == 400
    assert replay.json() == BAD
    assert len(stored()) == 1


def test_a_refused_message_does_not_use_up_a_token():
    client = visitor()
    body = good(client)
    assert send(client, {**body, "email": "nope"}).status_code == 400
    assert fake.asked == []

    assert send(client, body).status_code == 201


def test_cloudflare_being_down_fails_closed():
    response = submit(turnstile="unavailable")

    assert response.status_code == 503
    assert response.json() == {"detail": "Service unavailable."}
    assert stored() == []


def test_a_missing_secret_key_fails_closed_with_the_real_check(settings):
    settings.TURNSTILE_VERIFIER = "core.turnstile.CloudflareVerifier"
    settings.TURNSTILE_SECRET_KEY = ""

    response = submit()

    assert response.status_code == 503
    assert stored() == []


def test_there_is_no_route_to_fetch_a_form_token():
    for path in ("/api/v1/contact/start", "/api/v1/contact/challenge"):
        assert visitor().get(path, secure=True).status_code == 404


def test_the_old_started_field_is_refused_like_any_unknown_field():
    client = visitor()
    body = good(client, started="123.abc")

    assert send(client, body).status_code == 400


@pytest.mark.parametrize(
    "elapsed",
    [None, True, False, "5000", 5000.5, -1, -5000, 7 * 24 * 3600 * 1000 + 1, [5000]],
)
def test_a_missing_or_unusable_time_counts_as_a_rushed_form(elapsed):
    reference = reference_success()

    response = submit(elapsed=elapsed)

    assert_quarantined(response, reference)
    assert stored()[-1].spam_score == 100


def test_a_form_with_no_time_field_at_all_is_a_rushed_form():
    reference = reference_success()
    client = visitor()
    body = good(client)
    del body["elapsed"]

    assert_quarantined(send(client, body), reference)


@pytest.mark.parametrize("milliseconds", [0, 1, 2999])
def test_under_three_seconds_is_rushed(milliseconds):
    submit(elapsed=milliseconds)

    assert stored()[0].status == "spam"


@pytest.mark.parametrize("milliseconds", [3000, 3001, 60_000, 7 * 24 * 3600 * 1000])
def test_three_seconds_or_more_is_fine(milliseconds):
    submit(elapsed=milliseconds)

    assert stored()[0].status == "new"


def test_the_bad_challenge_error_does_not_say_what_else_failed():
    # A filled honeypot, a rushed form and too many links, all at once: the
    # answer is still only the check error.
    response = submit(
        turnstile="wrong",
        website="x",
        age=0,
        body="https://a.example https://b.example https://c.example https://d.example",
    )

    assert_bad_challenge(response)


# Rate limits


def post_many(count, **fixed):
    return [submit(**fixed).status_code for _ in range(count)]


def test_five_messages_an_hour_per_address():
    assert post_many(5) == [201] * 5

    response = submit()

    assert response.status_code == 429
    assert int(response["Retry-After"]) >= 1
    assert len(stored()) == 5


def test_another_address_is_not_affected():
    post_many(5)

    assert submit(ip="203.0.113.99").status_code == 201


def test_an_address_in_a_new_hour_starts_again(monkeypatch):
    post_many(5)
    assert submit().status_code == 429
    later = contact.now() + 3600
    monkeypatch.setattr(contact, "now", lambda: later)

    assert submit().status_code == 201


def test_three_messages_a_day_per_email():
    sent = [
        submit(ip=f"203.0.113.{n}", email="same@example.com").status_code
        for n in range(1, 4)
    ]

    assert sent == [201] * 3
    assert submit(ip="203.0.113.50", email="same@example.com").status_code == 429
    assert submit(ip="203.0.113.50", email="different@example.com").status_code == 201


def test_the_email_limit_ignores_case():
    for n, email in enumerate(["A@Example.com", "a@EXAMPLE.com", "a@example.com"]):
        assert submit(ip=f"203.0.113.{n + 1}", email=email).status_code == 201

    assert submit(ip="203.0.113.50", email=" A@example.COM ").status_code == 429


def test_a_daily_cap_for_everyone(settings):
    settings.CONTACT_DAILY_CAP = 3
    sent = [submit(ip=f"203.0.113.{n}").status_code for n in range(1, 4)]

    assert sent == [201] * 3
    assert submit(ip="203.0.113.50").status_code == 429
    assert len(stored()) == 3


def test_the_default_limits():
    from django.conf import settings

    assert settings.CONTACT_DAILY_CAP == 25
    assert settings.CONTACT_PER_ADDRESS_PER_HOUR == 5
    assert settings.CONTACT_PER_EMAIL_PER_DAY == 3
    assert settings.CONTACT_MIN_SECONDS == 3
    assert settings.RETENTION_SPAM_DAYS == 30
    assert settings.RETENTION_MESSAGE_DAYS == 365
    assert settings.CONTACT_SPAM_THRESHOLD == 100


def test_every_limit_gives_the_same_answer():
    ip_limited = (post_many(5), submit())[1]
    cache.client().flushdb()
    for n in range(3):
        submit(ip=f"203.0.113.{n + 10}", email="e@example.com")
    email_limited = submit(ip="203.0.113.80", email="e@example.com")

    assert ip_limited.status_code == email_limited.status_code == 429
    assert ip_limited.json() == email_limited.json()
    assert ip_limited.json() == {
        "detail": "Too many messages. Please try again later.",
        "code": "rate_limited",
    }


def test_the_global_cap_answers_like_the_other_limits(settings):
    settings.CONTACT_DAILY_CAP = 1
    submit(ip="203.0.113.1")

    response = submit(ip="203.0.113.2")

    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


def test_quarantined_messages_count_towards_the_daily_cap(settings):
    settings.CONTACT_DAILY_CAP = 2
    submit(ip="203.0.113.1", website="x")
    submit(ip="203.0.113.2", website="x")

    assert submit(ip="203.0.113.3").status_code == 429


def test_quarantined_messages_count_towards_the_address_limit():
    for _ in range(5):
        assert submit(website="x").status_code == 201

    assert submit().status_code == 429


def test_quarantined_messages_count_towards_the_email_limit():
    for n in range(3):
        submit(ip=f"203.0.113.{n + 1}", email="bot@example.com", website="x")

    assert submit(ip="203.0.113.9", email="bot@example.com").status_code == 429


def test_refused_attempts_still_count_for_the_address():
    for _ in range(5):
        submit(turnstile="wrong")

    assert submit().status_code == 429


def test_contact_limits_use_their_own_buckets():
    post_many(5)

    keys = [k.decode() for k in cache.client().keys("*")]
    assert keys
    assert not any(k.startswith("public:") for k in keys)
    assert not any(k.startswith("requests:") for k in keys)


def test_contact_traffic_does_not_use_up_the_public_read_limit(settings):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 2
    post_many(5)
    client = visitor()

    statuses = [
        client.get(
            "/api/v1/site", secure=True, headers={"Cf-Connecting-Ip": ADDRESS}
        ).status_code
        for _ in range(2)
    ]

    assert 429 not in statuses


def test_the_public_read_limit_does_not_apply_to_the_form(settings):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 1
    client = visitor()
    for _ in range(3):
        client.get("/api/v1/site", secure=True, headers={"Cf-Connecting-Ip": ADDRESS})

    assert submit().status_code == 201


def test_an_address_that_is_not_one_cannot_pick_a_fresh_bucket():
    # Anything that is not an address falls back to the connection's own.
    for n in range(5):
        submit(ip=f"not an address {n}")

    assert submit(ip="still not one").status_code == 429


# Failing closed


def test_the_form_fails_closed_without_redis(monkeypatch):
    client = visitor()
    body = good(client)
    redis_down(monkeypatch)

    response = send(client, body)

    assert response.status_code == 503
    assert stored() == []


def test_the_form_fails_closed_without_the_database(monkeypatch):
    client = visitor()
    body = good(client)
    database_down(monkeypatch)

    response = send(client, body)

    assert response.status_code == 503
    assert response.json() == {"detail": "Service unavailable."}


def test_a_retry_after_the_database_failed_is_stored_as_new(monkeypatch):
    text = "Hello, the form failed for me a moment ago, so here it is again."
    with monkeypatch.context() as patch:
        database_down(patch)
        assert submit(body=text).status_code == 503

    assert submit(body=text).status_code == 201

    assert [(m.status, m.spam_score) for m in stored()] == [("new", 0)]


def test_a_failed_store_keeps_an_earlier_marker_for_the_same_body(monkeypatch):
    text = "Hello, I sent this once already and it went through fine."
    assert submit(body=text).status_code == 201
    with monkeypatch.context() as patch:
        database_down(patch)
        assert submit(body=text).status_code == 503

    submit(body=text)

    assert [m.status for m in stored()] == ["new", "spam"]


# Logs hold ids and outcome codes only


PRIVATE_NAME = "Quincy Zzyzx"
PRIVATE_EMAIL = "quincy.zzyzx@secret-example.org"
PRIVATE_BODY = "My confidential message about the zebra project and a plan."
PRIVATE_ADDRESS = "203.0.113.77"
PRIVATE_WORDS = (
    "Quincy",
    "Zzyzx",
    "zzyzx",
    "secret-example",
    "zebra",
    "confidential",
    PRIVATE_ADDRESS,
)


def private_in(text):
    return [word for word in PRIVATE_WORDS if word in text]


def test_logs_never_hold_personal_data(caplog):
    caplog.set_level(logging.DEBUG)
    personal = {"name": PRIVATE_NAME, "email": PRIVATE_EMAIL, "body": PRIVATE_BODY}
    submit(ip=PRIVATE_ADDRESS, **personal)
    submit(ip=PRIVATE_ADDRESS, website="x", **{**personal, "email": "b@example.com"})
    submit(ip=PRIVATE_ADDRESS, turnstile="wrong", **personal)
    submit(ip=PRIVATE_ADDRESS, **{**personal, "email": "not valid"})
    for _ in range(6):
        submit(ip=PRIVATE_ADDRESS, **personal)

    assert private_in(caplog.text) == []


def test_logs_hold_the_id_and_an_outcome_code(caplog):
    caplog.set_level(logging.INFO)
    submit()
    submit(website="x")
    submit(turnstile="wrong")

    first, second = stored()
    assert f"id={first.id} outcome=stored" in caplog.text
    assert f"id={second.id} outcome=spam_honeypot" in caplog.text
    assert "outcome=bad_challenge" in caplog.text


def test_logs_hold_no_personal_data_when_storage_fails(caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    client = visitor()
    body = good(client, ip=PRIVATE_ADDRESS, name=PRIVATE_NAME, email=PRIVATE_EMAIL)
    database_down(monkeypatch)

    send(client, body, ip=PRIVATE_ADDRESS)

    assert private_in(caplog.text) == []
