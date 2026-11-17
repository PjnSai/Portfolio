"""Publishing purges the Cloudflare cache. A failed purge never undoes a publish."""

import json
import logging

import pytest

from core import purge
from core.models import AuditLog, SiteSettings

pytestmark = pytest.mark.django_db


class Recording:
    calls = []

    def purge(self):
        Recording.calls.append("purge")


class Broken:
    def purge(self):
        raise purge.PurgeFailed("cloudflare said no")


class Crashing:
    def purge(self):
        raise TimeoutError


@pytest.fixture(autouse=True)
def recording(settings):
    Recording.calls = []
    settings.CACHE_PURGER = "tests.test_purge.Recording"


def published_section(api):
    section = api.post("/sections", {"type": "text", "title": "Hello"}).json()["id"]
    return section, api.post(f"/sections/{section}/publish", {})


def test_publishing_a_section_purges_the_cache(signed_in):
    _, response = published_section(signed_in)

    assert response.status_code == 200
    assert response.json()["cache_purged"] is True
    assert Recording.calls == ["purge"]


def test_publishing_settings_purges_the_cache(signed_in):
    response = signed_in.post("/settings/publish", {})

    assert response.json()["cache_purged"] is True
    assert Recording.calls == ["purge"]


@pytest.mark.parametrize(
    "action",
    [
        lambda api, s: api.post(f"/sections/{s}/visibility", {"visible": False}),
        lambda api, s: api.post("/sections/reorder", {"ids": [s]}),
        lambda api, s: api.post(f"/sections/{s}/trash"),
    ],
    ids=["hide", "reorder", "trash"],
)
def test_changes_that_go_live_at_once_purge_too(signed_in, action):
    section, _ = published_section(signed_in)
    Recording.calls = []

    assert action(signed_in, section).status_code == 200
    assert Recording.calls == ["purge"]


@pytest.mark.parametrize("purger", ["Broken", "Crashing"])
def test_a_failed_purge_keeps_the_publish_and_is_reported(signed_in, settings, purger):
    settings.CACHE_PURGER = f"tests.test_purge.{purger}"

    section, response = published_section(signed_in)

    assert response.status_code == 200
    assert response.json() == {"version": 1, "cache_purged": False}
    detail = signed_in.get(f"/sections/{section}").json()
    assert detail["published_at"] is not None
    assert detail["unpublished_changes"] is False
    status = signed_in.get("/cache").json()
    assert status["purge_failed_at"] is not None
    assert AuditLog.objects.filter(event="cache_purge_failed").count() == 1


def test_retry_clears_the_report(signed_in, settings):
    settings.CACHE_PURGER = "tests.test_purge.Broken"
    published_section(signed_in)
    settings.CACHE_PURGER = "tests.test_purge.Recording"

    response = signed_in.post("/cache/purge")

    assert response.json() == {"cache_purged": True, "purge_failed_at": None}
    assert signed_in.get("/cache").json()["purge_failed_at"] is None
    assert SiteSettings.objects.get().purge_failed_at is None


def test_a_later_good_purge_clears_the_report(signed_in, settings):
    settings.CACHE_PURGER = "tests.test_purge.Broken"
    section, _ = published_section(signed_in)
    settings.CACHE_PURGER = "tests.test_purge.Recording"

    signed_in.post(f"/sections/{section}/publish", {})

    assert signed_in.get("/cache").json()["purge_failed_at"] is None


def test_a_missing_purger_is_a_failed_purge(signed_in, settings):
    settings.CACHE_PURGER = "core.purge.NoSuchPurger"

    _, response = published_section(signed_in)

    assert response.json()["cache_purged"] is False


def test_the_development_purger_only_logs(caplog):
    with caplog.at_level(logging.INFO, logger="core.purge"):
        purge.LogPurger().purge()

    assert "cache purge" in caplog.text


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_cloudflare_purger_sends_one_zone_purge_with_the_token(settings, monkeypatch):
    settings.CLOUDFLARE_ZONE_ID = "0123456789abcdef0123456789abcdef"
    settings.CLOUDFLARE_PURGE_TOKEN = "purge-only-token"  # noqa: S105
    sent = []

    def fake_open(request, timeout):
        sent.append((request, timeout))
        return FakeResponse(b'{"success": true}')

    monkeypatch.setattr(purge, "urlopen", fake_open)

    purge.CloudflarePurger().purge()

    request, timeout = sent[0]
    assert request.full_url == (
        "https://api.cloudflare.com/client/v4/zones/"
        "0123456789abcdef0123456789abcdef/purge_cache"
    )
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer purge-only-token"
    assert json.loads(request.data) == {"purge_everything": True}
    assert timeout <= 10


@pytest.mark.parametrize(
    "zone,token",
    [("", "t"), ("0123456789abcdef0123456789abcdef", ""), ("../../user", "t")],
)
def test_cloudflare_purger_refuses_without_valid_config(settings, zone, token):
    settings.CLOUDFLARE_ZONE_ID = zone
    settings.CLOUDFLARE_PURGE_TOKEN = token

    with pytest.raises(purge.PurgeFailed):
        purge.CloudflarePurger().purge()


def test_cloudflare_purger_reports_a_refusal(settings, monkeypatch):
    settings.CLOUDFLARE_ZONE_ID = "0123456789abcdef0123456789abcdef"
    settings.CLOUDFLARE_PURGE_TOKEN = "t"  # noqa: S105
    monkeypatch.setattr(
        purge, "urlopen", lambda request, timeout: FakeResponse(b'{"success": false}')
    )

    with pytest.raises(purge.PurgeFailed):
        purge.CloudflarePurger().purge()
