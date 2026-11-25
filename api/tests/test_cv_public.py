"""Viewing the public CV: the status, the link given after a human check, and
the file behind it. No download route, no public file URL, nothing public that
names a key, an id or a hash."""

import json

import pytest
from django.db import OperationalError
from django.test import Client

from core import cv, storage
from core.models import CvVersion, CvView, SiteSettings
from tests import pdfs
from tests.conftest import ORIGIN
from tests.turnstile import PASSES

pytestmark = pytest.mark.django_db

STATUS = "/api/v1/cv"
LINK = "/api/v1/cv/link"
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


def token():
    return f"{PASSES}#cv{next(_counter)}"


def add_version(data=pdfs.GOOD, live=True):
    item = cv.add(data)
    if live:
        cv.set_live(item.id)
        item.refresh_from_db()
    return item


@pytest.fixture
def live():
    return add_version()


def visitor():
    return Client(enforce_csrf_checks=True)


def ask_link(client=None, ip=ADDRESS, turnstile=None, raw=None, **headers):
    body = raw if raw is not None else json.dumps({"turnstile": turnstile or token()})
    return (client or visitor()).post(
        LINK,
        body,
        content_type="application/json",
        secure=True,
        headers={
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-site",
            "Cf-Connecting-Ip": ip,
            **headers,
        },
    )


def fetch(url, client=None, **headers):
    return (client or visitor()).get(
        url, secure=True, headers={"Origin": ORIGIN, **headers}
    )


def view_url(**kwargs):
    response = ask_link(**kwargs)
    assert response.status_code == 200, response.content
    return response.json()["url"]


def body_of(response):
    if response.streaming:
        return b"".join(response.streaming_content)
    return response.content


def secrets_of(item):
    """Everything about a version that must never reach a visitor."""
    return [
        str(item.id),
        item.id.hex,
        item.storage_key,
        item.storage_key[3:35],
        item.sha256,
    ]


def assert_nothing_secret(response, item):
    text = body_of(response).decode("latin-1") + json.dumps(dict(response.items()))
    for secret in secrets_of(item):
        assert secret not in text


# Status


def test_status_says_what_a_visitor_can_do(live):
    response = fetch(STATUS)

    assert response.status_code == 200
    assert response.json() == {
        "can_view": True,
        "can_request": True,
        "instant_download": True,
        "updated": live.created_at.date().isoformat(),
    }


def test_status_with_no_live_cv(client):
    add_version(live=False)

    assert fetch(STATUS).json() == {
        "can_view": False,
        "can_request": True,
        "updated": None,
    }


def test_status_follows_the_switches(live):
    SiteSettings.objects.create(cv_view_enabled=False, cv_request_enabled=False)

    body = fetch(STATUS).json()

    assert (body["can_view"], body["can_request"]) == (False, False)


def test_status_is_cacheable_for_a_short_time(live):
    cache = fetch(STATUS)["Cache-Control"]

    assert "public" in cache
    assert "max-age=60" in cache


def test_status_holds_no_key_id_or_hash(live):
    assert_nothing_secret(fetch(STATUS), live)


def test_status_refuses_query_strings(live):
    assert fetch(STATUS + "?id=1").status_code == 400


# The view link


def test_a_human_gets_a_link_that_lasts_a_minute(live):
    response = ask_link()

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"url", "expires_in"}
    assert body["expires_in"] == 60
    assert body["url"].startswith("/api/v1/cv/file/")
    assert response["Cache-Control"] == "no-store"
    assert_nothing_secret(response, live)


def test_a_failed_check_gets_no_link(live):
    response = ask_link(turnstile="wrong")

    assert response.status_code == 400
    assert response.json()["code"] == "challenge"
    assert "url" not in response.json()


def test_a_missing_token_gets_no_link(live):
    response = ask_link(raw="{}")

    assert response.status_code == 400
    assert "url" not in response.json()


def test_turnstile_being_unavailable_gives_no_link(live):
    response = ask_link(turnstile="unavailable")

    assert response.status_code == 503
    assert "url" not in response.json()


def test_the_database_failing_gives_no_link(live, monkeypatch):
    def broken(*args, **kwargs):
        raise OperationalError("gone")

    monkeypatch.setattr(cv, "switches", broken)

    response = ask_link()

    assert response.status_code == 503
    assert "url" not in response.json()


def test_redis_failing_gives_no_link(live, monkeypatch):
    import redis

    from core import cache

    def down():
        raise redis.ConnectionError("down")

    monkeypatch.setattr(cache, "client", down)

    response = ask_link()

    assert response.status_code == 503
    assert "url" not in response.json()


@pytest.mark.parametrize(
    "raw",
    ["", "[]", '"x"', "not json", json.dumps({"turnstile": "x", "id": "1"})],
)
def test_malformed_requests_are_refused(live, raw):
    assert ask_link(raw=raw).status_code == 400


def test_no_link_when_viewing_is_off(live):
    SiteSettings.objects.create(cv_view_enabled=False)

    response = ask_link()

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_no_link_when_no_version_is_live():
    add_version(live=False)

    response = ask_link()

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_links_are_limited_per_client_per_hour(live, settings):
    for _ in range(settings.CV_VIEW_PER_ADDRESS_PER_HOUR):
        assert ask_link().status_code == 200

    response = ask_link()

    assert response.status_code == 429
    assert int(response["Retry-After"]) > 0
    assert ask_link(ip="198.51.100.9").status_code == 200


def test_the_whole_site_has_a_daily_cap(live, settings):
    settings.CV_VIEW_DAILY_CAP = 2
    assert ask_link(ip="198.51.100.1").status_code == 200
    assert ask_link(ip="198.51.100.2").status_code == 200

    response = ask_link(ip="198.51.100.3")

    assert response.status_code == 429


def test_failed_checks_do_not_use_up_the_daily_cap(live, settings):
    settings.CV_VIEW_DAILY_CAP = 1
    for n in range(3):
        assert ask_link(ip=f"198.51.100.{n}", turnstile="wrong").status_code == 400

    assert ask_link().status_code == 200


def test_the_limits_have_their_defaults():
    from django.conf import settings

    assert settings.CV_VIEW_PER_ADDRESS_PER_HOUR == 10
    assert settings.CV_VIEW_DAILY_CAP == 200


def test_a_link_needs_the_site_origin(live):
    response = ask_link(Origin="https://evil.test", **{"Sec-Fetch-Site": "cross-site"})

    assert response.status_code == 403


def test_only_post_is_answered():
    assert fetch(LINK).status_code == 405


# The file


def test_the_link_gives_the_pdf_inline_with_safe_headers(live):
    SiteSettings.objects.create(published={"title": "Pujan Shahi"})

    response = fetch(view_url())

    assert response.status_code == 200
    assert body_of(response) == pdfs.GOOD
    assert response["Content-Type"] == "application/pdf"
    assert response["Content-Disposition"] == 'inline; filename="Pujan-Shahi-CV.pdf"'
    assert response["Content-Length"] == str(len(pdfs.GOOD))
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "no-store"
    assert response["X-Robots-Tag"] == "noindex"
    assert response["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in response["Content-Security-Policy"]


@pytest.mark.parametrize(
    "title,name",
    [
        ("", "cv.pdf"),
        ("   ", "cv.pdf"),
        ('"; filename=evil.exe', "filename-evil-exe-CV.pdf"),
        ("Zoë O'Brien\r\nX: y", "Zo-O-Brien-X-y-CV.pdf"),
        ("../../etc/passwd", "etc-passwd-CV.pdf"),
    ],
)
def test_the_file_name_is_letters_digits_and_hyphens(live, title, name):
    SiteSettings.objects.create(published={"title": title})

    response = fetch(view_url())

    assert response["Content-Disposition"] == f'inline; filename="{name}"'


def test_with_no_published_title_the_name_is_plain(live):
    assert 'filename="cv.pdf"' in fetch(view_url())["Content-Disposition"]


def test_the_file_and_its_headers_hold_no_key_id_or_hash(live):
    response = fetch(view_url())

    headers = json.dumps(dict(response.items()))
    for secret in secrets_of(live):
        assert secret not in headers


def test_a_link_can_be_used_from_the_site_origin_only(live):
    url = view_url()

    from_site = fetch(url)
    assert from_site["Access-Control-Allow-Origin"] == ORIGIN
    assert "Access-Control-Allow-Credentials" not in from_site
    assert "Origin" in from_site["Vary"]

    other = fetch(view_url(), Origin="https://evil.test")
    assert "Access-Control-Allow-Origin" not in other
    assert "Access-Control-Allow-Credentials" not in other


def tampered(url):
    last = url[-1]
    return url[:-1] + ("A" if last != "A" else "B")


@pytest.mark.parametrize(
    "change",
    [
        tampered,
        lambda url: url + "x",
        lambda url: url.rsplit(":", 2)[0] + ":abc:def",
        lambda url: "/api/v1/cv/file/" + "0" * 32,
        lambda url: "/api/v1/cv/file/" + "a" * 500,
    ],
    ids=["tampered", "longer", "forged", "made up", "very long"],
)
def test_a_bad_link_is_a_plain_not_found(live, change):
    response = fetch(change(view_url()))

    assert response.status_code == 404
    assert response.json() == NOT_FOUND
    assert CvView.objects.count() == 0


def test_a_link_from_another_purpose_is_refused(live):
    from django.core import signing

    forged = signing.TimestampSigner(salt="something-else").sign(
        view_url().rsplit("/", 1)[1].split(":")[0]
    )

    response = fetch("/api/v1/cv/file/" + forged)

    assert response.status_code == 404


def test_an_expired_link_is_a_plain_not_found(live, monkeypatch):
    import time

    url = view_url()
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 61)

    response = fetch(url)

    assert response.status_code == 404
    assert response.json() == NOT_FOUND


def test_a_link_still_works_within_its_minute(live, monkeypatch):
    import time

    url = view_url()
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 55)

    assert fetch(url).status_code == 200


def test_a_link_for_a_version_no_longer_live_is_a_plain_not_found(live):
    url = view_url()
    cv.set_live(add_version(pdfs.pdf(stream=b"(new)"), live=False).id)

    response = fetch(url)

    assert response.status_code == 404
    assert response.json() == NOT_FOUND


def test_the_file_is_refused_once_viewing_is_turned_off(live):
    url = view_url()
    SiteSettings.objects.create(cv_view_enabled=False)

    response = fetch(url)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


# The view log


def test_a_view_is_logged_with_no_address_or_email(live):
    fetch(
        view_url(),
        **{"Cf-Ipcountry": "GB", "User-Agent": "Mozilla/5.0 " + "x" * 300},
    )

    view = CvView.objects.get()
    assert view.version == live.id
    assert view.country == "GB"
    assert view.user_agent == ("Mozilla/5.0 " + "x" * 300)[:200]
    row = json.dumps({f.name: str(getattr(view, f.name)) for f in CvView._meta.fields})
    assert ADDRESS not in row
    assert "@" not in row


@pytest.mark.parametrize("country", ["", "XX", "T1", "gb", "GBR", "G", "<s"])
def test_an_unusable_country_is_stored_as_none(live, country):
    fetch(view_url(), **{"Cf-Ipcountry": country})

    assert CvView.objects.get().country == ""


def test_hidden_characters_are_removed_from_the_user_agent(live):
    fetch(view_url(), **{"User-Agent": "Agent‮/1.0\x07"})

    assert CvView.objects.get().user_agent == "Agent/1.0"


def test_no_link_or_failed_link_is_logged(live):
    ask_link(turnstile="wrong")
    fetch("/api/v1/cv/file/nothing")

    assert CvView.objects.count() == 0


def test_if_the_view_cannot_be_logged_the_file_is_not_served(live, monkeypatch):
    url = view_url()

    def broken(*args, **kwargs):
        raise OperationalError("gone")

    monkeypatch.setattr(CvView.objects, "create", broken)

    response = fetch(url)

    assert response.status_code == 503
    assert pdfs.GOOD not in body_of(response)


def test_if_the_file_cannot_be_read_nothing_is_logged(live, cv_root):
    url = view_url()
    (cv_root / CvVersion.objects.get().storage_key).unlink()

    response = fetch(url)

    assert response.status_code == 503
    assert CvView.objects.count() == 0


def test_if_the_database_fails_the_file_is_not_served(live, monkeypatch):
    url = view_url()

    def broken(*args, **kwargs):
        raise OperationalError("gone")

    monkeypatch.setattr(cv, "live", broken)

    response = fetch(url)

    assert response.status_code == 503
    assert pdfs.GOOD not in body_of(response)


def test_there_is_no_public_route_to_a_file_by_name_or_id(live):
    for path in (
        f"/api/v1/cv/{live.id}",
        f"/api/v1/cv/file/{live.id}",
        f"/api/v1/cv/{live.storage_key}",
        f"/api/v1/media/{live.storage_key}",
        "/api/v1/cv/download",
    ):
        assert fetch(path).status_code == 404, path


def test_the_storage_is_never_served_by_the_media_route(live):
    name = live.storage_key.split("/")[1]

    assert fetch(f"/api/v1/media/{name}").status_code == 404
    assert storage.CV_KEY.fullmatch(live.storage_key)


# CORS: the site's own origin only, never with credentials


def preflight(path, origin=ORIGIN, method="POST", headers="content-type"):
    return visitor().options(
        path,
        secure=True,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        },
    )


@pytest.mark.parametrize("path", [LINK, "/api/v1/cv/request"])
def test_the_form_preflights_are_answered_for_the_site_only(path):
    response = preflight(path)

    assert response.status_code == 204
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert response["Access-Control-Allow-Methods"] == "POST"
    assert "Access-Control-Allow-Credentials" not in response
    assert preflight(path, origin="https://evil.test").status_code == 403
    assert preflight(path, headers="content-type,x-csrf-token").status_code == 403
    assert preflight(path, method="GET").status_code == 403


@pytest.mark.parametrize("path", [STATUS, "/api/v1/cv/file/abc", "/api/v1/cv/x"])
def test_the_plain_reads_need_no_preflight_and_get_none(path):
    assert preflight(path, method="GET", headers="").status_code == 403


def test_the_status_can_be_read_by_the_site_only(live):
    from_site = fetch(STATUS)
    other = fetch(STATUS, Origin="https://evil.test")

    assert from_site["Access-Control-Allow-Origin"] == ORIGIN
    assert "Access-Control-Allow-Credentials" not in from_site
    assert "Origin" in from_site["Vary"]
    assert "Access-Control-Allow-Origin" not in other


def test_a_link_answer_can_be_read_by_the_site_only(live):
    from_site = ask_link()
    other = ask_link(Origin="https://evil.test", **{"Sec-Fetch-Site": "cross-site"})

    assert from_site["Access-Control-Allow-Origin"] == ORIGIN
    assert from_site["Access-Control-Expose-Headers"] == "Retry-After"
    assert "Access-Control-Allow-Credentials" not in from_site
    assert "Access-Control-Allow-Origin" not in other


def test_no_cors_header_on_paths_that_only_look_like_the_file(live):
    for path in ("/api/v1/cv/file/", "/api/v1/cv/file/a/b", "/api/v1/cv/files/a"):
        assert "Access-Control-Allow-Origin" not in fetch(path), path
