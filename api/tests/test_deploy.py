"""After a change goes live, the Pages site is rebuilt through its deploy hook:
at most one call per two minutes, each one audited, the hook URL never shown."""

import json
import logging
from datetime import timedelta

import pytest

from core import deploy
from core.models import AuditLog, SiteSettings

pytestmark = pytest.mark.django_db

HOOK = (
    "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/"
    "0b7c7a5e-hook-secret-part"
)


class Recording:
    calls = 0

    def deploy(self):
        Recording.calls += 1


class Broken:
    def deploy(self):
        raise deploy.DeployFailed("cloudflare said no")


@pytest.fixture(autouse=True)
def recording(settings):
    Recording.calls = 0
    settings.SITE_DEPLOYER = "tests.test_deploy.Recording"
    settings.PAGES_DEPLOY_HOOK_URL = HOOK


def publish(api):
    section = api.post("/sections", {"type": "text", "title": "Hello"}).json()["id"]
    return api.post(f"/sections/{section}/publish", {})


def age_last_call(minutes):
    row = SiteSettings.objects.get()
    row.deploy_called_at -= timedelta(minutes=minutes)
    row.save(update_fields=["deploy_called_at"])


def test_publishing_asks_pages_to_rebuild(signed_in):
    assert publish(signed_in).status_code == 200

    assert Recording.calls == 1
    status = signed_in.get("/deploy").json()
    assert status["result"] == "ok"
    assert status["pending"] is False
    assert status["called_at"] is not None


@pytest.mark.parametrize(
    "action",
    [
        lambda api, s: api.post(f"/sections/{s}/visibility", {"visible": False}),
        lambda api, s: api.post("/sections/reorder", {"ids": [s]}),
        lambda api, s: api.post(f"/sections/{s}/trash"),
        lambda api, s: api.post("/settings/publish", {}),
    ],
    ids=["hide", "reorder", "trash", "settings"],
)
def test_changes_that_go_live_at_once_rebuild_too(signed_in, action):
    section = signed_in.post("/sections", {"type": "text", "title": "Hi"}).json()["id"]

    assert action(signed_in, section).status_code == 200
    assert Recording.calls == 1


def test_calls_within_two_minutes_are_debounced_and_kept_pending(signed_in):
    publish(signed_in)
    publish(signed_in)
    publish(signed_in)

    assert Recording.calls == 1
    status = signed_in.get("/deploy").json()
    assert status["pending"] is True
    assert 0 < status["retry_after"] <= 120


def test_after_two_minutes_the_next_change_calls_again_and_clears_pending(signed_in):
    publish(signed_in)
    publish(signed_in)
    age_last_call(2)

    publish(signed_in)

    assert Recording.calls == 2
    assert signed_in.get("/deploy").json()["pending"] is False


def test_deploy_now_sends_a_pending_change_once_the_wait_is_over(signed_in):
    publish(signed_in)
    publish(signed_in)

    early = signed_in.post("/deploy")
    assert early.status_code == 200
    assert early.json()["pending"] is True
    assert Recording.calls == 1

    age_last_call(2)
    later = signed_in.post("/deploy").json()

    assert Recording.calls == 2
    assert later["pending"] is False
    assert later["result"] == "ok"


def test_each_trigger_writes_an_audit_entry(signed_in):
    publish(signed_in)
    publish(signed_in)

    called = AuditLog.objects.filter(event="site_deploy_requested")
    debounced = AuditLog.objects.filter(event="site_deploy_debounced")
    assert called.count() == 1
    assert called.get().detail == {"reason": "section_published", "result": "ok"}
    assert debounced.count() == 1
    assert debounced.get().detail == {"reason": "section_published"}


def test_a_failed_call_keeps_the_publish_and_is_shown(signed_in, settings):
    settings.SITE_DEPLOYER = "tests.test_deploy.Broken"

    response = publish(signed_in)

    assert response.status_code == 200
    assert signed_in.get("/deploy").json()["result"] == "failed"
    entry = AuditLog.objects.get(event="site_deploy_requested")
    assert entry.detail == {
        "reason": "section_published",
        "result": "failed",
        "error": "DeployFailed",
    }


def test_the_development_deployer_only_logs(caplog):
    with caplog.at_level(logging.INFO, logger="core.deploy"):
        deploy.LogDeployer().deploy()

    assert "deploy" in caplog.text


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_pages_deployer_posts_to_the_hook(monkeypatch):
    sent = []

    def fake_urlopen(request, timeout):
        sent.append((request.full_url, request.get_method(), timeout))
        return FakeResponse(json.dumps({"success": True}).encode())

    monkeypatch.setattr("core.deploy.urlopen", fake_urlopen)

    deploy.PagesDeployer().deploy()

    assert sent == [(HOOK, "POST", deploy.TIMEOUT)]


@pytest.mark.parametrize(
    "url",
    [
        "",
        "http://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc",
        "https://api.cloudflare.com.evil.test/client/v4/pages/webhooks/deploy_hooks/a",
        "https://evil.test/client/v4/pages/webhooks/deploy_hooks/abc",
        "https://api.cloudflare.com/client/v4/zones/abc/purge_cache",
        "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/../x",
    ],
)
def test_pages_deployer_refuses_any_other_url(monkeypatch, settings, url):
    settings.PAGES_DEPLOY_HOOK_URL = url
    monkeypatch.setattr(
        "core.deploy.urlopen", lambda *a, **k: pytest.fail("must not be called")
    )

    with pytest.raises(deploy.DeployFailed):
        deploy.PagesDeployer().deploy()


def test_pages_deployer_reports_a_refusal(monkeypatch):
    monkeypatch.setattr(
        "core.deploy.urlopen",
        lambda *a, **k: FakeResponse(json.dumps({"success": False}).encode()),
    )

    with pytest.raises(deploy.DeployFailed):
        deploy.PagesDeployer().deploy()


def test_the_hook_url_is_never_logged_stored_or_returned(
    signed_in, settings, monkeypatch, caplog
):
    settings.SITE_DEPLOYER = "core.deploy.PagesDeployer"

    def failing(request, timeout):
        raise OSError(f"could not reach {request.full_url}")

    monkeypatch.setattr("core.deploy.urlopen", failing)

    with caplog.at_level(logging.DEBUG):
        publish(signed_in)
        status = signed_in.get("/deploy")
        again = signed_in.post("/deploy")

    part = HOOK.rsplit("-", 2)[-2] + "-secret-part"
    assert status.json()["result"] == "failed"
    assert part not in caplog.text
    assert part not in status.content.decode()
    assert part not in again.content.decode()
    for entry in AuditLog.objects.all():
        assert part not in json.dumps(entry.detail)
