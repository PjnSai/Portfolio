"""The PowerShell scripts for local mode (scripts/), read as text: they must
agree with the launcher and never read secrets."""

import re
from pathlib import Path

import pytest

from devmode import config

SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"


def script(name):
    return (SCRIPTS / name).read_text(encoding="utf-8")


def code(text):
    """The script without its comments, block (<# #>) and line (#)."""
    text = re.sub(r"<#.*?#>", "", text, flags=re.DOTALL)
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


ALL = ["dev.ps1", "dev-web.ps1", "dev-common.ps1"]


@pytest.mark.parametrize("name", ALL)
def test_no_script_reads_an_env_file(name):
    assert not re.search(r"\.env\b", code(script(name)))


@pytest.mark.parametrize("name", ALL)
def test_no_script_uses_powershell_7_only_syntax(name):
    """Windows PowerShell 5.1 has no && or || chains, ternaries or ??."""
    body = code(script(name))
    assert not re.search(r"&&|\|\||\?\?|\s\?\s.+\s:\s", body)


def test_the_site_is_built_against_the_dev_api():
    body = script("dev-web.ps1")
    assert f'"http://localhost:{config.API_PORT}"' in body
    assert f'"{config.WEB_ORIGIN}"' in body
    assert f'"{config.TURNSTILE_SITE_KEY}"' in body


def test_the_site_is_served_on_localhost_only():
    body = script("dev-web.ps1")
    assert 'HOSTNAME = "localhost"' in body
    assert "0.0.0.0" not in body


def test_the_build_is_never_a_pages_build():
    """CF_PAGES makes the build demand production settings; it is cleared."""
    body = script("dev-web.ps1")
    assert 'CF_PAGES = $null' in body


def test_the_start_script_uses_the_test_containers():
    body = script("dev.ps1")
    assert '"portfolio-test-db"' in body
    assert '"portfolio-test-redis"' in body


def test_the_start_script_never_chooses_where_the_api_binds():
    """The launcher binds to 127.0.0.1 and refuses anything else; the script
    passes no host, so it cannot ask for one."""
    body = code(script("dev.ps1"))
    assert "devmode" in body and "serve" in body
    assert "--host" not in body


@pytest.mark.parametrize("action", ["start", "stop", "reset", "status", "refresh"])
def test_the_start_script_has_each_action(action):
    assert f'"{action}"' in script("dev.ps1")


def test_a_full_reset_asks_first():
    body = code(script("dev.ps1"))
    assert "Read-Host" in body
