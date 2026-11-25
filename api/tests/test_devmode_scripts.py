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


ALL = ["dev-web.ps1", "dev-common.ps1"]


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

