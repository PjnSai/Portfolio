"""Instant download: a visitor who asks for a copy, and passes the human check
and the limits, gets a link that downloads the live CV for a minute. Everyone
who passes gets one, blocked or flagged as spam or not, so the answer never
tells them apart."""

import json

import pytest
import redis
from django.db import OperationalError
from django.test import Client

from core import blocklist, cache, contact, cv
from core.models import ContactMessage, SiteSettings
from tests import pdfs
from tests.conftest import ORIGIN
from tests.test_cv_public import add_version, assert_nothing_secret, fetch
from tests.turnstile import PASSES

pytestmark = pytest.mark.django_db

STATUS = "/api/v1/cv"
REQUEST = "/api/v1/cv/request"
SENT = {"detail": "Thank you. Your message has been received."}
ADDRESS = "203.0.113.7"
_counter = iter(range(1, 10**6))


@pytest.fixture(autouse=True)
def cv_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_ROOT = tmp_path / "media"
    settings.CV_ROOT = tmp_path / "cv"
    return settings.CV_ROOT


@pytest.fixture
def live():
    return add_version()


def switches(view=True, request=True, instant_download=True):
    SiteSettings.objects.create(
        cv_view_enabled=view,
        cv_request_enabled=request,
        cv_instant_download_enabled=instant_download,
    )


def good(**overrides):
    n = next(_counter)
    body = {
        "name": "Sam Recruiter",
        "email": f"sam{n}@example.com",
        "note": f"For the graduate role, reference {n}.",
        "website": "",
        "elapsed": 30_000,
        "turnstile": f"{PASSES}#dl{n}",
    }
    body.update(overrides)
    return body


def ask(body=None, ip=ADDRESS):
    return Client(enforce_csrf_checks=True).post(
        REQUEST,
        json.dumps(body if body is not None else good()),
        content_type="application/json",
        secure=True,
        headers={
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-site",
            "Cf-Connecting-Ip": ip,
        },
    )


def assert_link(response):
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"detail", "url", "expires_in"}
    assert body["detail"] == SENT["detail"]
    assert body["url"].startswith("/api/v1/cv/file/")
    assert body["expires_in"] == 60
    assert response["Cache-Control"] == "no-store"


def assert_no_link(response):
    assert "url" not in response.json()
    assert "expires_in" not in response.json()


# The status


def test_status_says_instant_download_is_on(live):
    assert fetch(STATUS).json()["instant_download"] is True


@pytest.mark.parametrize(
    "on", [{"instant_download": False}, {"request": False}], ids=["off", "no request"]
)
def test_status_leaves_it_out_unless_it_applies(live, on):
    switches(**on)

    assert "instant_download" not in fetch(STATUS).json()


def test_status_leaves_it_out_with_no_live_cv():
    add_version(live=False)

    assert "instant_download" not in fetch(STATUS).json()


def test_status_still_holds_no_key_id_or_hash(live):
    assert_nothing_secret(fetch(STATUS), live)


# The link


def test_a_request_answers_with_a_download_link(live):
    response = ask()

    assert_link(response)
    assert ContactMessage.objects.get().kind == ContactMessage.Kind.CV_REQUEST
    assert_nothing_secret(response, live)


def test_a_blocked_sender_gets_the_same_answer_and_nothing_is_stored(live):
    plain = ask()
    blocklist.block_email("blocked@example.com")
    ContactMessage.objects.all().delete()

    response = ask(good(email="Blocked@Example.com"))

    assert_link(response)
    assert set(response.json()) == set(plain.json())
    assert ContactMessage.objects.count() == 0


def test_a_spam_flagged_request_gets_the_same_answer_and_is_kept_as_spam(live):
    response = ask(good(website="http://spam.test"))

    assert_link(response)
    message = ContactMessage.objects.get()
    assert message.status == ContactMessage.Status.SPAM
    assert message.kind == ContactMessage.Kind.CV_REQUEST


def test_spam_past_its_daily_cap_gets_the_same_answer_and_nothing_is_stored(live):
    from core import limits

    cap = limits.effective()["spam_daily_cap"]
    for n in range(cap):
        ask(good(website="http://spam.test"), ip=f"198.51.100.{n % 250}")
    ContactMessage.objects.all().delete()

    response = ask(good(website="http://spam.test"), ip="192.0.2.9")

    assert_link(response)
    assert ContactMessage.objects.count() == 0


def test_a_failed_check_gets_no_link(live):
    response = ask(good(turnstile="wrong"))

    assert response.status_code == 400
    assert_no_link(response)


def test_a_rate_limited_request_gets_no_link(live, settings):
    for _ in range(settings.CONTACT_PER_ADDRESS_PER_HOUR):
        assert ask().status_code == 201

    response = ask()

    assert response.status_code == 429
    assert_no_link(response)


def test_no_link_when_instant_download_is_off(live):
    switches(instant_download=False)

    response = ask()

    assert response.status_code == 201
    assert response.json() == SENT


def test_no_link_when_no_version_is_live():
    add_version(live=False)

    response = ask()

    assert response.status_code == 201
    assert response.json() == SENT


def test_no_link_when_there_is_no_cv_at_all():
    assert ask().json() == SENT


def test_requests_off_means_no_request_and_no_link(live):
    switches(request=False)

    response = ask()

    assert response.status_code == 403
    assert_no_link(response)


def test_turnstile_being_unavailable_gives_503_and_no_link(live):
    response = ask(good(turnstile="unavailable"))

    assert response.status_code == 503
    assert_no_link(response)


@pytest.mark.parametrize("where", ["store", "live", "switches"])
def test_the_database_failing_gives_503_and_no_link(live, monkeypatch, where):
    def down(*args, **kwargs):
        raise OperationalError("down")

    monkeypatch.setattr(contact if where == "store" else cv, where, down)

    response = ask()

    assert response.status_code == 503
    assert_no_link(response)


def test_redis_failing_gives_503_and_no_link(live, monkeypatch):
    def down():
        raise redis.ConnectionError("down")

    monkeypatch.setattr(cache, "client", down)

    response = ask()

    assert response.status_code == 503
    assert_no_link(response)


def test_the_link_is_for_the_version_live_when_asked(live):
    url = ask().json()["url"]
    cv.set_live(add_version(pdfs.pdf(stream=b"(new)"), live=False).id)

    assert fetch(url).status_code == 404
