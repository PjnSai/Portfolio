"""Abuse counters: each refusal or flag adds exactly one to its kind, a count
that cannot be taken never changes the answer, and the summary holds counts
only."""

import json
import logging
from datetime import timedelta

import pytest
from django.db import DatabaseError, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import abuse, blocklist, ratelimit
from core.models import AbuseCount, RateLimitBlock
from tests.conftest import ORIGIN
from tests.test_contact import ADDRESS, good, send, submit, visitor

pytestmark = pytest.mark.django_db

ADMIN = "/api/v1/admin"


def counts():
    return {row.kind: row.count for row in AbuseCount.objects.filter(day=abuse.today())}


def only(kind, n=1):
    """Exactly n of kind today and nothing of any other kind."""
    found = {k: v for k, v in counts().items() if v}
    assert found == {kind: n}


def public_post(path, body, ip=ADDRESS, headers=None):
    client = visitor()
    sent = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-site", "Cf-Connecting-Ip": ip}
    sent.update(headers or {})
    return client.post(
        path,
        json.dumps(body),
        content_type="application/json",
        secure=True,
        headers=sent,
    )


def public_get(client, path):
    return client.get(path, secure=True, headers={"Cf-Connecting-Ip": ADDRESS})


# Counting itself


def test_one_count_adds_one_in_one_statement_once_the_day_exists():
    abuse.count(abuse.SPAM)

    with CaptureQueriesContext(connection) as queries:
        abuse.count(abuse.SPAM)

    writes = [q["sql"] for q in queries.captured_queries if "abuse_counts" in q["sql"]]
    assert len(writes) == 1
    assert writes[0].startswith("UPDATE")
    assert '"count" + 1' in writes[0]
    only(abuse.SPAM, 2)


def test_the_first_count_of_a_day_makes_every_kind_at_zero():
    abuse.count(abuse.RATE_LIMITED)

    assert counts() == {
        kind: 1 if kind == abuse.RATE_LIMITED else 0 for kind in abuse.KINDS
    }


def test_counts_are_kept_per_day():
    yesterday = abuse.today() - timedelta(days=1)
    AbuseCount.objects.create(day=yesterday, kind=abuse.SPAM, count=4)

    abuse.count(abuse.SPAM)

    assert AbuseCount.objects.get(day=yesterday, kind=abuse.SPAM).count == 4
    only(abuse.SPAM)


def test_an_unknown_kind_is_not_counted_and_does_not_raise(caplog):
    abuse.count("someone@example.com")

    assert AbuseCount.objects.count() == 0
    assert "someone@example.com" not in caplog.text


def test_a_count_that_cannot_be_taken_is_logged_and_does_not_raise(monkeypatch, caplog):
    def down(*args, **kwargs):
        raise DatabaseError("down")

    monkeypatch.setattr(abuse, "_add", down)
    caplog.set_level(logging.WARNING, logger="core.abuse")

    abuse.count(abuse.SPAM)

    assert "abuse count failed kind=spam error=DatabaseError" in caplog.text


# Each place that refuses or flags adds exactly one


def test_contact_rate_limit_counts_once(settings):
    for _ in range(5):
        assert submit().status_code == 201
    AbuseCount.objects.all().delete()

    response = submit()

    assert response.status_code == 429
    only(abuse.RATE_LIMITED)


def test_failed_turnstile_counts_once():
    response = submit(turnstile="fails")

    assert response.status_code == 400
    only(abuse.TURNSTILE_FAILED)


def test_blocked_sender_counts_once():
    blocklist.block_email("blocked@example.com")

    response = submit(email="blocked@example.com")

    assert response.status_code == 201
    only(abuse.BLOCKED_SENDER)


@pytest.mark.parametrize(
    "overrides,kind",
    [
        ({"website": "http://bot.example"}, abuse.HONEYPOT_OR_TIMING),
        ({"elapsed": 500}, abuse.HONEYPOT_OR_TIMING),
        (
            {"body": "See https://a.example https://b.example https://c.example"},
            abuse.SPAM,
        ),
    ],
    ids=["honeypot", "timing", "links"],
)
def test_each_spam_signal_counts_once(overrides, kind):
    response = submit(**overrides)

    assert response.status_code == 201
    only(kind)


def test_a_repeated_body_counts_as_spam_once():
    body = "The same words sent twice in one day, word for word."
    assert submit(body=body).status_code == 201
    assert not any(counts().values())

    assert submit(body=body).status_code == 201

    only(abuse.SPAM)


def test_spam_past_its_daily_cap_still_counts_once(settings):
    from core.models import SiteSettings

    SiteSettings.objects.create(contact_spam_daily_cap=1)
    submit(website="x")
    AbuseCount.objects.all().delete()

    response = submit(website="x")

    assert response.status_code == 201
    only(abuse.HONEYPOT_OR_TIMING)


def test_an_invalid_form_counts_once():
    response = submit(email="not an address")

    assert response.status_code == 400
    only(abuse.REJECTED_FORM)


@pytest.mark.parametrize(
    "raw", ["not json", "[]", json.dumps({"extra": 1}), json.dumps({"x": "y" * 30_000})]
)
def test_an_unreadable_form_counts_once(raw):
    response = send(visitor(), None, raw=raw)

    assert response.status_code in (400, 413)
    only(abuse.REJECTED_FORM)


def test_a_good_message_counts_nothing():
    assert submit().status_code == 201

    assert not any(counts().values())


def test_public_read_cap_counts_once(client, settings):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 1
    public_get(client, "/api/v1/site")
    AbuseCount.objects.all().delete()

    response = public_get(client, "/api/v1/site")

    assert response.status_code == 429
    only(abuse.RATE_LIMITED)


@pytest.mark.parametrize("path", ["/api/v1/cv", "/api/v1/media/" + "0" * 32 + ".webp"])
def test_other_public_read_caps_count_once(client, settings, path):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 0

    response = public_get(client, path)

    assert response.status_code == 429
    only(abuse.RATE_LIMITED)


def test_wrong_origin_on_a_public_form_counts_once():
    response = public_post(
        "/api/v1/contact", good(), headers={"Origin": "https://evil.test"}
    )

    assert response.status_code == 403
    only(abuse.GUARD_REFUSED)


def test_admin_request_without_access_counts_once(api):
    response = api.get("/session", headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403
    only(abuse.GUARD_REFUSED)


def test_admin_request_cap_counts_once(signed_in, settings):
    settings.ADMIN_REQUESTS_PER_MINUTE = 3
    AbuseCount.objects.all().delete()

    statuses = [signed_in.get("/session").status_code for _ in range(2)]

    assert statuses[-1] == 429
    only(abuse.RATE_LIMITED, statuses.count(429))


def test_a_body_over_the_guard_limit_counts_once(api, settings):
    settings.MAX_BODY_BYTES = 10

    response = api.post("/login/options", {"padding": "x" * 50})

    assert response.status_code == 413
    only(abuse.GUARD_REFUSED)


def test_failed_sign_in_counts_once(api, passkey):
    response = api.login(passkey, origin="https://evil.test")

    assert response.status_code == 401
    only(abuse.LOGIN_FAILED)


def test_failed_bootstrap_counts_once(api, db):
    response = api.post("/bootstrap/options", {"token": "wrong"})

    assert response.status_code == 401
    only(abuse.LOGIN_FAILED)


def test_failed_recovery_counts_once(api, passkey):
    response = api.post("/recovery/options", {"key": "wrong"})

    assert response.status_code == 401
    only(abuse.LOGIN_FAILED)


@pytest.mark.parametrize(
    "path,body",
    [
        ("/login/options", {}),
        ("/login/verify", {"credential": {}}),
        ("/bootstrap/options", {"token": "x"}),
        ("/bootstrap/verify", {"token": "x"}),
        ("/recovery/options", {"key": "x"}),
        ("/recovery/verify", {"key": "x"}),
    ],
)
def test_a_sign_in_during_a_cool_down_counts_once(api, passkey, path, body):
    RateLimitBlock.objects.create(
        key_hash=ratelimit.keyed("ip:127.0.0.1"),
        scope="login",
        expires_at=timezone.now() + timedelta(minutes=5),
    )

    response = api.post(path, body)

    assert response.status_code == 429
    only(abuse.RATE_LIMITED)


def test_failed_elevation_counts_once(signed_in, passkey):
    AbuseCount.objects.all().delete()

    response = signed_in.elevate(passkey, origin="https://evil.test")

    assert response.status_code == 403
    only(abuse.ELEVATION_FAILED)


def test_upload_cap_counts_once(signed_in, settings):
    from tests.test_media import upload

    settings.MEDIA_DAILY_UPLOADS = 0
    AbuseCount.objects.all().delete()

    response = upload(signed_in, b"not read")

    assert response.status_code == 429
    only(abuse.RATE_LIMITED)


# A count that fails never changes the answer


def _counting_down(monkeypatch):
    def down(*args, **kwargs):
        raise DatabaseError("down")

    monkeypatch.setattr(abuse, "_add", down)


@pytest.mark.parametrize(
    "overrides,status",
    [
        ({"turnstile": "fails"}, 400),
        ({"email": "bad"}, 400),
        ({"website": "x"}, 201),
        ({}, 201),
    ],
)
def test_contact_answer_is_the_same_when_counting_fails(monkeypatch, overrides, status):
    expected = submit(**overrides)
    _counting_down(monkeypatch)

    response = submit(**overrides)

    assert expected.status_code == response.status_code == status
    assert response.json() == expected.json()


def test_blocked_sender_answer_is_the_same_when_counting_fails(monkeypatch):
    blocklist.block_email("blocked@example.com")
    _counting_down(monkeypatch)

    response = submit(email="blocked@example.com")

    assert response.status_code == 201
    assert response.json() == {"detail": "Thank you. Your message has been received."}


def test_sign_in_answer_is_the_same_when_counting_fails(api, passkey, monkeypatch):
    _counting_down(monkeypatch)

    assert api.login(passkey, origin="https://evil.test").status_code == 401
    assert api.login(passkey).status_code == 200


def test_guard_answer_is_the_same_when_counting_fails(api, monkeypatch):
    _counting_down(monkeypatch)

    response = api.get("/session", headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden."}


def test_rate_limit_answer_is_the_same_when_counting_fails(
    client, settings, monkeypatch
):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 0
    _counting_down(monkeypatch)

    response = public_get(client, "/api/v1/site")

    assert response.status_code == 429
    assert response["Retry-After"]


def test_a_failed_count_inside_a_transaction_leaves_it_usable(monkeypatch):
    from django.db import transaction

    from core.models import Owner

    real = abuse._add

    def broken(kind, day):
        real(kind, day)
        raise DatabaseError("after the write")

    monkeypatch.setattr(abuse, "_add", broken)
    with transaction.atomic():
        abuse.count(abuse.SPAM)
        assert Owner.objects.count() >= 0

    assert AbuseCount.objects.count() == 0


# The summary route


def test_summary_needs_a_session(api, passkey):
    assert api.get("/abuse").status_code == 401


def test_summary_defaults_to_the_last_thirty_days(signed_in):
    old = abuse.today() - timedelta(days=30)
    AbuseCount.objects.create(day=old, kind=abuse.SPAM, count=9)
    AbuseCount.objects.create(day=abuse.today(), kind=abuse.SPAM, count=2)
    AbuseCount.objects.create(
        day=abuse.today() - timedelta(days=29), kind=abuse.RATE_LIMITED, count=3
    )

    body = signed_in.get("/abuse").json()

    assert body["to"] == abuse.today().isoformat()
    assert body["from"] == (abuse.today() - timedelta(days=29)).isoformat()
    assert len(body["days"]) == 30
    assert body["kinds"] == list(abuse.KINDS)
    assert body["totals"][abuse.SPAM] == 2
    assert body["totals"][abuse.RATE_LIMITED] == 3
    assert body["days"][0]["counts"][abuse.RATE_LIMITED] == 3
    assert body["days"][-1]["counts"][abuse.SPAM] == 2
    assert all(set(day["counts"]) == set(abuse.KINDS) for day in body["days"])


def test_summary_takes_a_range_and_a_kind(signed_in):
    AbuseCount.objects.create(day="2026-03-02", kind=abuse.SPAM, count=5)
    AbuseCount.objects.create(day="2026-03-02", kind=abuse.LOGIN_FAILED, count=1)
    AbuseCount.objects.create(day="2026-03-04", kind=abuse.SPAM, count=1)

    body = signed_in.get(
        "/abuse", {"from": "2026-03-01", "to": "2026-03-03", "kind": "spam"}
    ).json()

    assert body == {
        "from": "2026-03-01",
        "to": "2026-03-03",
        "kinds": ["spam"],
        "totals": {"spam": 5},
        "days": [
            {"day": "2026-03-01", "counts": {"spam": 0}},
            {"day": "2026-03-02", "counts": {"spam": 5}},
            {"day": "2026-03-03", "counts": {"spam": 0}},
        ],
    }


@pytest.mark.parametrize(
    "params",
    [
        {"from": "2026-03-04", "to": "2026-03-01"},
        {"from": "2025-01-01", "to": "2026-03-01"},
        {"from": "yesterday"},
        {"to": "2026-02-30"},
        {"kind": "everything"},
        {"kind": "spam' OR 1=1"},
        {"limit": "5"},
    ],
)
def test_summary_refuses_bad_parameters(signed_in, params):
    assert signed_in.get("/abuse", params).status_code == 400


def test_summary_refuses_a_repeated_parameter(signed_in):
    response = signed_in.get("/abuse?kind=spam&kind=spam")

    assert response.status_code == 400


def test_summary_holds_no_address_email_or_text(signed_in, settings):
    blocklist.block_email("blocked@example.com")
    submit(email="blocked@example.com", body="Secret words in the message body.")
    submit(website="x", body="Other secret words in a body.", ip="198.51.100.9")
    submit(turnstile="fails")
    settings.PUBLIC_REQUESTS_PER_MINUTE = 0
    visitor().get("/api/v1/site", secure=True, headers={"Cf-Connecting-Ip": ADDRESS})

    text = signed_in.get("/abuse").content.decode()

    assert counts()[abuse.BLOCKED_SENDER] == 1
    for private in (
        "blocked@example.com",
        "@",
        "Secret words",
        "secret words",
        ADDRESS,
        "198.51.100.9",
        "127.0.0.1",
    ):
        assert private not in text
    stored = json.dumps(
        list(AbuseCount.objects.values("day", "kind", "count")), default=str
    )
    assert "@" not in stored and ADDRESS not in stored


def test_the_table_has_counts_only():
    names = {field.name for field in AbuseCount._meta.get_fields()}

    assert names == {"id", "day", "kind", "count"}


# Retention


def test_the_daily_job_removes_days_past_the_period_in_one_delete():
    from core import retention
    from core.models import AuditLog

    today = abuse.today()
    kept = today - timedelta(days=abuse.KEEP_DAYS)
    gone = today - timedelta(days=abuse.KEEP_DAYS + 1)
    AbuseCount.objects.create(day=kept, kind=abuse.SPAM, count=1)
    AbuseCount.objects.create(day=gone, kind=abuse.SPAM, count=1)
    AbuseCount.objects.create(day=gone, kind=abuse.LOGIN_FAILED, count=1)

    assert retention.run(dry_run=True)["abuse_counts_deleted"] == 2
    assert AbuseCount.objects.count() == 3
    with CaptureQueriesContext(connection) as queries:
        counts = retention.run()

    deletes = [
        q["sql"]
        for q in queries.captured_queries
        if q["sql"].startswith('DELETE FROM "abuse_counts"')
    ]
    assert len(deletes) == 1
    assert counts["abuse_counts_deleted"] == 2
    assert list(AbuseCount.objects.values_list("day", flat=True)) == [kept]
    entry = AuditLog.objects.filter(event="retention_run").last()
    assert entry.detail["abuse_counts_deleted"] == 2
