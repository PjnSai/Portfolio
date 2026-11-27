"""Production refuses to start with a Turnstile check that is not real.

Production is a Cloud Run container, which always has K_SERVICE set. The
settings are loaded in a fresh interpreter, as gunicorn loads them at start.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from config import settings as base
from devmode import guards

API = Path(__file__).resolve().parent.parent
REAL_SECRET = "0x4AAAAAAAexampleexampleexampleAAAA"  # noqa: S105 - not a key.
REAL_VERIFIER = "core.turnstile.CloudflareVerifier"
FAKE_VERIFIER = "tests.turnstile.FakeVerifier"
DUMMIES = sorted(guards.DUMMY_TURNSTILE_SECRETS)


def load_settings(**env):
    clean = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("K_", "TURNSTILE_", "DJANGO_SETTINGS"))
    }
    clean.update(
        {
            "DJANGO_SECRET_KEY": "x" * 50,
            "AUDIT_CHAIN_KEY": "y" * 32,
            "TURNSTILE_SECRET_KEY": REAL_SECRET,
            **env,
        }
    )
    clean = {key: value for key, value in clean.items() if value is not None}
    return subprocess.run(  # noqa: S603 - fixed interpreter and arguments.
        [sys.executable, "-c", "import config.settings"],
        cwd=API,
        env=clean,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_production_starts_with_a_real_secret_and_the_real_verifier():
    result = load_settings(K_SERVICE="portfolio-api")
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("secret", [*DUMMIES, "", None])
def test_production_refuses_a_dummy_or_missing_secret(secret):
    result = load_settings(K_SERVICE="portfolio-api", TURNSTILE_SECRET_KEY=secret)
    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr
    assert "TURNSTILE_SECRET_KEY" in result.stderr
    if secret:
        assert secret not in result.stderr


@pytest.mark.parametrize("verifier", [FAKE_VERIFIER, "core.turnstile.Unavailable"])
def test_production_refuses_any_other_verifier(verifier):
    result = load_settings(K_SERVICE="portfolio-api", TURNSTILE_VERIFIER=verifier)
    assert result.returncode != 0
    assert "TURNSTILE_VERIFIER" in result.stderr


@pytest.mark.parametrize("secret", [*DUMMIES, ""])
def test_the_same_values_still_load_outside_production(secret):
    result = load_settings(
        TURNSTILE_SECRET_KEY=secret, TURNSTILE_VERIFIER=FAKE_VERIFIER
    )
    assert result.returncode == 0, result.stderr


def test_every_published_dummy_secret_is_recognised():
    for secret in DUMMIES:
        assert base.turnstile_problems(secret, REAL_VERIFIER)
    assert base.turnstile_problems(REAL_SECRET, REAL_VERIFIER) == []


def test_tests_run_outside_production(settings):
    assert settings.PRODUCTION is False
    assert settings.TURNSTILE_VERIFIER == FAKE_VERIFIER


def test_local_mode_still_refuses_the_production_marker():
    assert "K_SERVICE" in guards.PRODUCTION_NAMES
