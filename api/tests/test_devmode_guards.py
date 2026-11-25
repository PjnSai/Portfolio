"""The local development launcher (devmode) refuses anything that could be
production. These run without a network: name lookups are replaced."""

import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from devmode import config, guards

API = Path(__file__).resolve().parent.parent
GOOD_DB = "postgres://postgres:postgres@127.0.0.1:55432/portfolio_dev"
GOOD_REDIS = "redis://127.0.0.1:6379/13"


def no_lookup(*args, **kwargs):
    raise AssertionError("a name lookup was made")


def answers(*addresses):
    def lookup(host, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 0)) for a in addresses]

    return lookup


def failing_lookup(*args, **kwargs):
    raise socket.gaierror("no such host")


# Inherited environment


def test_a_clean_environment_passes():
    assert guards.inherited({"PATH": "x", "DATABASE_URL": "anything"}) == []


@pytest.mark.parametrize(
    "name",
    [
        "CLOUDFLARE_PURGE_TOKEN",
        "CLOUDFLARE_ZONE_ID",
        "PAGES_DEPLOY_HOOK_URL",
        "GCS_MEDIA_BUCKET",
        "GCS_CV_BUCKET",
        "K_SERVICE",
        "K_REVISION",
    ],
)
def test_a_production_value_in_the_environment_is_refused(name):
    problems = guards.inherited({name: "something"})
    assert len(problems) == 1 and name in problems[0]


def test_an_empty_production_value_is_not_a_refusal():
    assert guards.inherited({"CLOUDFLARE_PURGE_TOKEN": ""}) == []


def test_a_real_turnstile_secret_is_refused():
    problems = guards.inherited({"TURNSTILE_SECRET_KEY": "0x4AAAAAAAreal-looking"})
    assert problems and "TURNSTILE_SECRET_KEY" in problems[0]


@pytest.mark.parametrize("secret", sorted(guards.DUMMY_TURNSTILE_SECRETS))
def test_cloudflare_dummy_turnstile_secrets_pass(secret):
    assert guards.inherited({"TURNSTILE_SECRET_KEY": secret}) == []


@pytest.mark.parametrize(
    "origin",
    [
        "https://pujanshahi.dev",
        "https://localhost.example.com",
        "http://localhost.evil.test:3000",
        "http://localhost:3000/path",
        "localhost:3000",
    ],
)
def test_a_site_origin_that_is_not_local_is_refused(origin):
    problems = guards.inherited({"SITE_ORIGIN": origin})
    assert problems and "SITE_ORIGIN" in problems[0]


@pytest.mark.parametrize(
    "origin", ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost"]
)
def test_a_local_site_origin_passes(origin):
    assert guards.inherited({"SITE_ORIGIN": origin}) == []


@pytest.mark.parametrize(
    "name, value",
    [
        ("MEDIA_STORAGE", "gcs"),
        ("CACHE_PURGER", "core.purge.CloudflarePurger"),
        ("SITE_DEPLOYER", "core.deploy.PagesDeployer"),
        ("DJANGO_SETTINGS_MODULE", "tests.settings"),
    ],
)
def test_other_production_choices_are_refused(name, value):
    problems = guards.inherited({name: value})
    assert problems and name in problems[0]


# Database and Redis


def test_the_default_database_passes():
    assert guards.database_url(GOOD_DB, lookup=no_lookup) == []


@pytest.mark.parametrize(
    "url",
    [
        "postgres://postgres:postgres@127.0.0.1:55432/portfolio",
        "postgres://postgres:postgres@127.0.0.1:55432/portfolio_e2e",
        "postgres://postgres:postgres@127.0.0.1:55432/portfolio_dev_backup",
        "postgres://postgres:postgres@127.0.0.1:55432/",
    ],
)
def test_a_database_not_ending_in_dev_is_refused(url):
    problems = guards.database_url(url, lookup=no_lookup)
    assert problems and "_dev" in problems[0]


def test_a_remote_database_is_refused():
    url = "postgres://u:p@ep-cool-name.eu-west-2.aws.neon.tech/portfolio_dev"
    problems = guards.database_url(url, lookup=answers("3.10.20.30"))
    assert problems and "loopback" in problems[0]


def test_a_container_name_on_loopback_passes():
    url = "postgres://u:p@portfolio-test-db:5432/portfolio_dev"
    assert guards.database_url(url, lookup=answers("127.0.0.1")) == []


def test_a_name_that_resolves_to_loopback_and_elsewhere_is_refused():
    url = "postgres://u:p@mixed.test:5432/portfolio_dev"
    assert guards.database_url(url, lookup=answers("127.0.0.1", "10.0.0.5"))


def test_a_host_that_cannot_be_looked_up_is_refused():
    url = "postgres://u:p@unknown.test:5432/portfolio_dev"
    assert guards.database_url(url, lookup=failing_lookup)


@pytest.mark.parametrize(
    "url",
    [
        "mysql://u:p@127.0.0.1/portfolio_dev",
        "postgres://u:p@/portfolio_dev",
        "not a url",
        "",
    ],
)
def test_a_database_url_that_cannot_be_checked_is_refused(url):
    assert guards.database_url(url, lookup=no_lookup)


def test_the_default_redis_passes():
    assert guards.redis_url(GOOD_REDIS, lookup=no_lookup) == []


@pytest.mark.parametrize(
    "url",
    [
        "redis://cache.example.com:6379/0",
        "rediss://127.0.0.1:6379/0",
        "redis://127.0.0.1:6379/14",
        "redis://127.0.0.1:6379/15",
        "",
    ],
)
def test_a_redis_that_is_remote_or_shared_with_tests_is_refused(url):
    assert guards.redis_url(url, lookup=answers("3.3.3.3"))


# Bind address


def test_binding_to_loopback_passes():
    assert guards.bind("127.0.0.1", 8000) == []


@pytest.mark.parametrize(
    "host",
    ["0.0.0.0", "::", "", "localhost", "192.168.1.10"],  # noqa: S104
)
def test_binding_anywhere_else_is_refused(host):
    problems = guards.bind(host, 8000)
    assert problems and "127.0.0.1" in problems[0]


@pytest.mark.parametrize("port", [0, 80, 70000])
def test_an_odd_port_is_refused(port):
    assert guards.bind("127.0.0.1", port)


# Settings as Django loaded them


def good_settings(**changes):
    values = {
        "DEBUG": True,
        "DATABASES": {"default": {"NAME": "portfolio_dev", "HOST": "127.0.0.1"}},
        "REDIS_URL": GOOD_REDIS,
        "SITE_ORIGIN": config.WEB_ORIGIN,
        "TURNSTILE_SECRET_KEY": config.TURNSTILE_SECRET_KEY,
        "MEDIA_STORAGE": "local",
        "GCS_MEDIA_BUCKET": "",
        "GCS_CV_BUCKET": "",
        "CLOUDFLARE_PURGE_TOKEN": "",
        "CLOUDFLARE_ZONE_ID": "",
        "PAGES_DEPLOY_HOOK_URL": "",
        "CACHE_PURGER": "core.purge.LogPurger",
        "SITE_DEPLOYER": "core.deploy.LogDeployer",
        "CF_ACCESS_TEAM_DOMAIN": config.TEAM,
    }
    values.update(changes)
    return SimpleNamespace(**values)


DEBUG_ON = {"DJANGO_DEBUG": "1"}


def test_the_settings_the_launcher_makes_pass():
    assert guards.loaded(good_settings(), DEBUG_ON, lookup=no_lookup) == []


def test_debug_must_have_been_set_by_the_launcher():
    assert guards.loaded(good_settings(), {}, lookup=no_lookup)
    assert guards.loaded(good_settings(DEBUG=False), DEBUG_ON, lookup=no_lookup)


@pytest.mark.parametrize(
    "changes",
    [
        {"DATABASES": {"default": {"NAME": "portfolio", "HOST": "127.0.0.1"}}},
        {"DATABASES": {"default": {"NAME": "portfolio_dev", "HOST": "db.neon.tech"}}},
        {"DATABASES": {}},
        {"REDIS_URL": "redis://cache.example.com:6379/13"},
        {"SITE_ORIGIN": "https://pujanshahi.dev"},
        {"TURNSTILE_SECRET_KEY": "0x4AAAAAAAreal-looking"},
        {"TURNSTILE_SECRET_KEY": ""},
        {"MEDIA_STORAGE": "gcs"},
        {"GCS_MEDIA_BUCKET": "media-bucket"},
        {"GCS_CV_BUCKET": "cv-bucket"},
        {"CLOUDFLARE_PURGE_TOKEN": "token"},
        {"CLOUDFLARE_ZONE_ID": "zone"},
        {"PAGES_DEPLOY_HOOK_URL": "https://api.cloudflare.com/hook"},
        {"CACHE_PURGER": "core.purge.CloudflarePurger"},
        {"SITE_DEPLOYER": "core.deploy.PagesDeployer"},
        {"CF_ACCESS_TEAM_DOMAIN": "pujan.cloudflareaccess.com"},
    ],
)
def test_any_production_looking_setting_is_refused(changes):
    lookup = answers("3.3.3.3")
    assert guards.loaded(good_settings(**changes), DEBUG_ON, lookup=lookup)


def test_a_setting_that_is_missing_is_refused_not_skipped():
    settings = good_settings()
    del settings.CLOUDFLARE_PURGE_TOKEN
    assert guards.loaded(settings, DEBUG_ON, lookup=no_lookup)


def test_enforce_raises_with_every_reason():
    with pytest.raises(guards.Refused) as raised:
        guards.enforce(["first reason", "second reason"])
    assert "first reason" in str(raised.value)
    assert "second reason" in str(raised.value)
    guards.enforce([])


# The environment the launcher builds


def test_the_launcher_environment_passes_its_own_checks():
    env = config.environment(GOOD_DB, GOOD_REDIS, bootstrap_sha256="0" * 64)
    assert env["DJANGO_DEBUG"] == "1"
    assert env["SITE_ORIGIN"] == "http://localhost:3000"
    assert env["TURNSTILE_SECRET_KEY"] in guards.DUMMY_TURNSTILE_SECRETS
    assert env["CF_ACCESS_TEAM_DOMAIN"].endswith(".invalid")
    assert env["CF_ACCESS_EMAIL"].endswith(".invalid")
    assert env["NOTIFIERS"] == "core.notify.LogNotifier"
    assert env["MEDIA_STORAGE"] == "local"
    assert guards.inherited(env) == []


# The launcher refuses as a process: a clear message and a non-zero exit


# tests/settings.py puts these in this process's environment.
SET_BY_TEST_SETTINGS = (
    "DJANGO_",
    "DEV_",
    "SITE_ORIGIN",
    "CF_ACCESS_",
    "BOOTSTRAP_TOKEN_SHA256",
    "AUDIT_CHAIN_KEY",
)


def run_launcher(*args, **env):
    import os

    clean = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(SET_BY_TEST_SETTINGS)
    }
    clean.update(env)
    return subprocess.run(  # noqa: S603 - fixed interpreter and arguments.
        [sys.executable, "-m", "devmode", *args],
        cwd=API,
        env=clean,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_the_launcher_refuses_a_production_token_and_exits_non_zero():
    result = run_launcher("check", CLOUDFLARE_PURGE_TOKEN="x")
    assert result.returncode != 0
    assert "Refusing to start" in result.stderr
    assert "CLOUDFLARE_PURGE_TOKEN" in result.stderr


def test_the_launcher_refuses_a_database_not_ending_in_dev():
    url = "postgres://postgres:postgres@127.0.0.1:55432/portfolio"
    result = run_launcher("check", DEV_DATABASE_URL=url)
    assert result.returncode != 0
    assert "_dev" in result.stderr


def test_the_launcher_refuses_to_bind_elsewhere():
    result = run_launcher("serve", "--host", "0.0.0.0")  # noqa: S104
    assert result.returncode != 0
    assert "127.0.0.1" in result.stderr


def test_the_launcher_check_passes_in_a_clean_environment():
    result = run_launcher("check")
    assert result.returncode == 0, result.stderr
