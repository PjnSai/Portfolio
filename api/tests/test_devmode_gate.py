"""The fake Cloudflare Access gate lives only in the launcher process. The
production check (core.access) is untouched, and production code never loads
the dev module."""

import ast
import os
import subprocess
import sys
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import override_settings

from core import access
from devmode import config, gate

API = Path(__file__).resolve().parent.parent
# Taken before any test fixture patches it.
REAL_FETCH = access.fetch_signing_key
DEV = {
    "CF_ACCESS_TEAM_DOMAIN": config.TEAM,
    "CF_ACCESS_AUD": config.AUDIENCE,
    "CF_ACCESS_EMAIL": config.EMAIL,
}


@pytest.fixture(scope="module")
def dev_key():
    return gate.new_key()


def dev_token(key):
    return gate.token(
        key, team=config.TEAM, audience=config.AUDIENCE, email=config.EMAIL
    )


# Production code never reaches the dev module


def production_files():
    for folder in ("config", "core"):
        yield from (API / folder).rglob("*.py")
    for name in ("manage.py", "gunicorn.conf.py"):
        yield API / name


def test_no_production_file_imports_or_names_the_dev_module():
    found = []
    for path in production_files():
        text = path.read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(text)):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                # Dotted paths loaded by import_string from settings.
                names = [node.value]
            if any(n == "devmode" or n.startswith("devmode.") for n in names):
                found.append(str(path.relative_to(API)))
    assert found == []


def test_importing_the_production_app_loads_no_dev_module_and_no_patch():
    script = (
        "import sys\n"
        "import config.wsgi\n"
        "from core import access\n"
        "loaded = [m for m in sys.modules if m.split('.')[0] == 'devmode']\n"
        "assert loaded == [], loaded\n"
        "assert access.fetch_signing_key.__module__ == 'core.access'\n"
        "print('clean')\n"
    )
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("DJANGO_")},
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "DJANGO_SECRET_KEY": "test-only",
        "AUDIT_CHAIN_KEY": "test-only",
    }
    result = subprocess.run(  # noqa: S603 - fixed interpreter and script.
        [sys.executable, "-c", script],
        cwd=API,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "clean"


def test_the_docker_image_leaves_the_dev_module_out():
    ignored = (API / ".dockerignore").read_text().split()
    assert "devmode" in ignored
    assert ".devmode" in ignored
    dockerfile = (API / "Dockerfile").read_text()
    assert "devmode" not in dockerfile


# The production check, with no launcher


def test_the_real_check_still_refuses_an_admin_request_with_no_token(api):
    api.access_token = None
    assert api.get("/csrf").status_code == 403


def test_the_real_check_refuses_the_dev_token_without_the_patch(monkeypatch, dev_key):
    """With the real key lookup, the key comes from Cloudflare's list, which a
    throwaway local key is not in. Stood in here by another key, so no network."""
    cloudflare = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class Keys:
        def get_signing_key_from_jwt(self, token):
            return type("Found", (), {"key": cloudflare.public_key()})()

    monkeypatch.setattr(access, "fetch_signing_key", REAL_FETCH)
    monkeypatch.setattr(access, "_jwks", lambda url: Keys())
    with override_settings(**DEV):
        assert access.is_valid(dev_token(dev_key)) is False


def test_the_real_key_lookup_is_not_replaced_by_importing_the_gate():
    assert REAL_FETCH.__module__ == "core.access"
    assert REAL_FETCH.__name__ == "fetch_signing_key"


def test_the_dev_token_does_not_fit_the_production_settings(monkeypatch, dev_key):
    """Even with the dev key accepted, the dev audience, issuer and email
    are not the production ones."""
    monkeypatch.setattr(access, "fetch_signing_key", lambda t: dev_key.public_key())
    assert access.is_valid(dev_token(dev_key)) is False


# The gate inside the launcher


def test_the_patch_makes_the_real_check_accept_the_dev_token(monkeypatch, dev_key):
    monkeypatch.setattr(access, "fetch_signing_key", REAL_FETCH)
    gate.install(dev_key)
    with override_settings(**DEV):
        assert access.is_valid(dev_token(dev_key)) is True


def test_the_patch_refuses_a_token_signed_by_another_key(monkeypatch, dev_key):
    other = gate.new_key()
    monkeypatch.setattr(access, "fetch_signing_key", REAL_FETCH)
    gate.install(dev_key)
    with override_settings(**DEV):
        assert access.is_valid(dev_token(other)) is False


def test_the_dev_token_is_short_lived(dev_key):
    claims = jwt.decode(
        dev_token(dev_key),
        dev_key.public_key(),
        algorithms=["RS256"],
        audience=config.AUDIENCE,
    )
    assert claims["exp"] - claims["iat"] <= 60
    assert claims["exp"] > time.time()
    assert claims["email"] == config.EMAIL
    assert claims["iss"] == f"https://{config.TEAM}"


def run_gate(dev_key, environ):
    seen = {}

    def app(env, start_response):
        seen.update(env)
        return [b"ok"]

    wrapped = gate.Gate(
        app, dev_key, team=config.TEAM, audience=config.AUDIENCE, email=config.EMAIL
    )
    wrapped(dict(environ), lambda *a: None)
    return seen.get(gate.HEADER_KEY)


def test_a_loopback_request_gets_a_valid_token(dev_key):
    token = run_gate(dev_key, {"REMOTE_ADDR": "127.0.0.1"})
    claims = jwt.decode(
        token, dev_key.public_key(), algorithms=["RS256"], audience=config.AUDIENCE
    )
    assert claims["email"] == config.EMAIL


def test_a_token_the_client_sent_is_replaced(dev_key):
    sent = "sent-by-the-browser"
    given = run_gate(dev_key, {"REMOTE_ADDR": "127.0.0.1", gate.HEADER_KEY: sent})
    assert given != sent


@pytest.mark.parametrize("address", ["192.168.1.20", "10.0.0.1", "", None])
def test_a_request_from_elsewhere_gets_no_token(dev_key, address):
    environ = {gate.HEADER_KEY: "forged"}
    if address is not None:
        environ["REMOTE_ADDR"] = address
    assert run_gate(dev_key, environ) is None
