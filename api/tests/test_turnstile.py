"""The real Turnstile check, with Cloudflare's answer faked at the network call."""

import io
import json
from urllib.error import URLError
from urllib.parse import parse_qs

import pytest

from core import turnstile

DUMMY_PASSES = "1x0000000000000000000000000000000AA"
DUMMY_FAILS = "2x0000000000000000000000000000000AA"


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def cloudflare(monkeypatch, settings):
    """Fake the network. Set .reply to a body (or an exception) to send back."""
    settings.TURNSTILE_SECRET_KEY = DUMMY_PASSES
    calls = []

    class State:
        reply = {"success": True}

    def urlopen(request, timeout):
        calls.append((request, timeout))
        if isinstance(State.reply, Exception):
            raise State.reply
        body = (
            State.reply if isinstance(State.reply, bytes) else json.dumps(State.reply)
        )
        return Answer(body if isinstance(body, bytes) else body.encode())

    monkeypatch.setattr(turnstile, "urlopen", urlopen)
    State.calls = calls
    return State


def verify(token="a-token"):
    return turnstile.CloudflareVerifier().verify(token)


def test_a_good_token_passes(cloudflare):
    assert verify() is True


def test_it_asks_cloudflare_with_the_secret_and_the_token_only(cloudflare):
    verify("the-token")

    ((request, timeout),) = cloudflare.calls
    assert (
        request.full_url == "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    )
    assert request.get_method() == "POST"
    sent = parse_qs(request.data.decode())
    assert sent == {"secret": [DUMMY_PASSES], "response": ["the-token"]}
    assert timeout == turnstile.TIMEOUT <= 5


@pytest.mark.parametrize(
    "codes",
    [
        ["invalid-input-response"],
        ["missing-input-response"],
        ["timeout-or-duplicate"],
        [],
        None,
    ],
)
def test_a_token_cloudflare_refuses_fails_the_visitor(cloudflare, codes):
    cloudflare.reply = {"success": False, "error-codes": codes}

    assert verify() is False


@pytest.mark.parametrize(
    "codes",
    [
        ["invalid-input-secret"],
        ["missing-input-secret"],
        ["bad-request"],
        ["internal-error"],
        ["invalid-input-response", "invalid-input-secret"],
    ],
)
def test_a_fault_on_our_side_is_unavailable_not_a_failed_visitor(cloudflare, codes):
    cloudflare.reply = {"success": False, "error-codes": codes}

    with pytest.raises(turnstile.Unavailable):
        verify()


@pytest.mark.parametrize(
    "reply",
    [
        URLError("no route"),
        TimeoutError("slow"),
        ConnectionResetError("reset"),
        b"<html>Bad gateway</html>",
        b"",
        b"[]",
        b'"yes"',
        b"null",
        {"success": "true"},
        {"success": 1},
        {},
    ],
)
def test_an_answer_that_cannot_be_trusted_is_unavailable(cloudflare, reply):
    cloudflare.reply = reply

    with pytest.raises(turnstile.Unavailable):
        verify()


def test_no_secret_key_means_unavailable_and_no_call(cloudflare, settings):
    settings.TURNSTILE_SECRET_KEY = ""

    with pytest.raises(turnstile.Unavailable):
        verify()

    assert cloudflare.calls == []


def test_the_dummy_keys_are_the_published_ones():
    assert DUMMY_PASSES.startswith("1x") and DUMMY_FAILS.startswith("2x")
    from tests import settings as test_settings

    assert test_settings.TURNSTILE_SECRET_KEY == DUMMY_PASSES
    assert test_settings.TURNSTILE_VERIFIER == "tests.turnstile.FakeVerifier"
