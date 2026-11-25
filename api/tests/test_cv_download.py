"""Instant download: a visitor who asks for a copy, and passes the human check
and the limits, gets a link that downloads the live CV for a minute. Everyone
who passes gets one, blocked or flagged as spam or not, so the answer never
tells them apart."""

import json

import pytest
import redis
from django.core import signing
from django.db import OperationalError
from django.test import Client

from core import blocklist, cache, contact, cv
from core.models import ContactMessage, CvView, SiteSettings
from tests import pdfs
from tests.conftest import ORIGIN
from tests.test_cv_public import (
    add_version,
    assert_nothing_secret,
    body_of,
    fetch,
    secrets_of,
)
from tests.turnstile import PASSES

pytestmark = pytest.mark.django_db

STATUS = "/api/v1/cv"
REQUEST = "/api/v1/cv/request"
SENT = {"detail": "Thank you. Your message has been received."}
ADDRESS = "203.0.113.7"
NOT_FOUND = {"detail": "Not found."}
FORBIDDEN = {"detail": "Forbidden."}
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


# The file behind a download link


def download_url():
    response = ask()
    assert response.status_code == 201, response.content
    return response.json()["url"]


def view_url():
    response = Client(enforce_csrf_checks=True).post(
        "/api/v1/cv/link",
        json.dumps({"turnstile": f"{PASSES}#v{next(_counter)}"}),
        content_type="application/json",
        secure=True,
        headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-site"},
    )
    assert response.status_code == 200, response.content
    return response.json()["url"]


def token_of(url):
    return url.rsplit("/", 1)[1]


def test_a_download_link_gives_the_pdf_as_an_attachment(live):
    SiteSettings.objects.create(published={"title": "Pujan Shahi"})

    response = fetch(download_url())

    assert response.status_code == 200
    assert body_of(response) == pdfs.GOOD
    assert response["Content-Type"] == "application/pdf"
    assert response["Content-Disposition"] == (
        'attachment; filename="Pujan-Shahi-CV.pdf"'
    )
    assert response["Content-Length"] == str(len(pdfs.GOOD))
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "no-store"
    assert response["X-Robots-Tag"] == "noindex"
    assert response["X-Frame-Options"] == "DENY"
    assert_nothing_secret_in_headers(response, live)


def assert_nothing_secret_in_headers(response, item):
    headers = json.dumps(dict(response.items()))
    for secret in secrets_of(item):
        assert secret not in headers


def test_a_download_is_logged_as_a_download(live):
    fetch(download_url(), **{"Cf-Ipcountry": "GB", "User-Agent": "Browser/2.0"})

    row = CvView.objects.get()
    assert (row.kind, row.version, row.country, row.user_agent) == (
        "download",
        live.id,
        "GB",
        "Browser/2.0",
    )


def test_a_view_is_still_logged_as_a_view_and_shown_inline(live):
    response = fetch(view_url())

    assert response["Content-Disposition"].startswith("inline;")
    assert CvView.objects.get().kind == "view"


def test_a_view_token_never_works_as_a_download_token(live):
    view = token_of(view_url())
    download = token_of(download_url())

    with pytest.raises(signing.BadSignature):
        signing.TimestampSigner(salt=cv.LINK_SALTS[cv.DOWNLOAD]).unsign(view)
    with pytest.raises(signing.BadSignature):
        signing.TimestampSigner(salt=cv.LINK_SALTS[cv.VIEW]).unsign(download)
    assert cv.linked(view)[0] == cv.VIEW
    assert cv.linked(download)[0] == cv.DOWNLOAD


def test_a_view_token_cannot_download_once_viewing_is_off(live):
    url = view_url()
    switches(view=False)

    assert fetch(url).status_code == 403
    assert CvView.objects.count() == 0


def test_a_download_token_works_with_viewing_off(live):
    switches(view=False)

    response = fetch(download_url())

    assert response.status_code == 200
    assert response["Content-Disposition"].startswith("attachment;")


@pytest.mark.parametrize(
    "off", [{"instant_download": False}, {"request": False}], ids=["off", "no request"]
)
def test_a_download_token_is_refused_once_its_switch_is_off(live, off):
    url = download_url()
    switches(**off)

    response = fetch(url)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN
    assert CvView.objects.count() == 0


def tampered(url):
    return url[:-1] + ("A" if url[-1] != "A" else "B")


@pytest.mark.parametrize(
    "change",
    [tampered, lambda url: url + "x", lambda url: url.rsplit(":", 2)[0] + ":a:b"],
    ids=["tampered", "longer", "forged"],
)
def test_a_bad_download_link_is_a_plain_not_found(live, change):
    response = fetch(change(download_url()))

    assert response.status_code == 404
    assert response.json() == NOT_FOUND
    assert CvView.objects.count() == 0


def test_an_expired_download_link_is_a_plain_not_found(live, monkeypatch):
    import time

    url = download_url()
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 61)

    response = fetch(url)

    assert response.status_code == 404
    assert response.json() == NOT_FOUND


def test_if_the_download_cannot_be_logged_the_file_is_not_sent(live, monkeypatch):
    url = download_url()

    def broken(*args, **kwargs):
        raise OperationalError("gone")

    monkeypatch.setattr(CvView.objects, "create", broken)

    response = fetch(url)

    assert response.status_code == 503
    assert pdfs.GOOD not in body_of(response)


def test_if_the_file_cannot_be_read_no_download_is_logged(live, cv_root):
    url = download_url()
    (cv_root / live.storage_key).unlink()

    response = fetch(url)

    assert response.status_code == 503
    assert CvView.objects.count() == 0
