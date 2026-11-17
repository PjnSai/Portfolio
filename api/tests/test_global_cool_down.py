"""The global cool-down, started by failures from many addresses.

It must slow an attacker without locking the owner out: bootstrap closes and
every failed sign-in is throttled, but a valid passkey still signs in.
"""

import os

import pytest

from core.models import AdminCredential, AuditLog, RateLimitBlock, Session
from tests.authenticator import SoftAuthenticator
from tests.conftest import COOKIE

pytestmark = pytest.mark.django_db

THROTTLED = {"detail": "Too many requests."}
OWNER_ADDRESS = "10.9.9.9"


def sign_in(api, authenticator, address, **tamper):
    headers = {"Cf-Connecting-Ip": address}
    options = api.post("/login/options", headers=headers)
    if options.status_code != 200:
        return options
    credential = authenticator.get(options.json(), **tamper)
    response = api.post("/login/verify", {"credential": credential}, headers=headers)
    if response.status_code == 200:
        api.csrf = response.json()["csrf_token"]
    return response


@pytest.fixture
def global_cool_down(new_api, settings, db):
    settings.LOGIN_GLOBAL_MAX_FAILURES = 3
    for n in range(3):
        response = sign_in(new_api(), SoftAuthenticator(), f"10.0.0.{n}")
        assert response.status_code == 401
    assert RateLimitBlock.objects.get().scope == "login-global"


def test_owner_can_still_sign_in_with_a_valid_passkey(
    new_api, passkey, global_cool_down
):
    api = new_api()

    response = sign_in(api, passkey, OWNER_ADDRESS)

    assert response.status_code == 200
    assert api.get("/session").status_code == 200
    assert AuditLog.objects.filter(event="login").count() == 1


def test_owner_signing_in_does_not_end_the_cool_down(
    new_api, passkey, global_cool_down
):
    assert sign_in(new_api(), passkey, OWNER_ADDRESS).status_code == 200

    response = sign_in(new_api(), SoftAuthenticator(), "10.0.1.1")

    assert response.status_code == 429
    assert RateLimitBlock.objects.filter(scope="login-global").exists()


def failures(passkey):
    stranger = SoftAuthenticator()
    return {
        "unknown passkey": (stranger, {}),
        "known id, wrong key": (passkey, {"key": stranger.key}),
        "unknown id, known key": (passkey, {"credential_id": os.urandom(32)}),
        "wrong origin": (passkey, {"origin": "https://evil.test"}),
    }


@pytest.mark.parametrize(
    "case",
    ["unknown passkey", "known id, wrong key", "unknown id, known key", "wrong origin"],
)
def test_every_failed_sign_in_is_throttled_and_looks_the_same(
    new_api, passkey, global_cool_down, case
):
    authenticator, tamper = failures(passkey)[case]
    baseline = sign_in(new_api(), SoftAuthenticator(), "10.0.1.1")

    response = sign_in(new_api(), authenticator, "10.0.1.2", **tamper)

    assert response.status_code == baseline.status_code == 429
    assert response.json() == baseline.json() == THROTTLED
    assert int(response["Retry-After"]) > 0
    assert response.headers.keys() == baseline.headers.keys()
    assert COOKIE not in response.cookies
    assert Session.objects.count() == 0


def test_bootstrap_is_closed_even_with_the_right_token(new_api, global_cool_down):
    headers = {"Cf-Connecting-Ip": "10.0.1.3"}
    body = {"token": "bootstrap-token"}

    options = new_api().post("/bootstrap/options", body, headers=headers)
    verify = new_api().post("/bootstrap/verify", body, headers=headers)

    assert options.status_code == verify.status_code == 429
    assert options.json() == THROTTLED
    assert AdminCredential.objects.count() == 0


def test_a_clients_own_cool_down_still_refuses_the_right_passkey(
    new_api, passkey, global_cool_down
):
    for _ in range(5):
        sign_in(new_api(), SoftAuthenticator(), OWNER_ADDRESS)

    assert sign_in(new_api(), passkey, OWNER_ADDRESS).status_code == 429
    assert sign_in(new_api(), passkey, "10.9.9.10").status_code == 200
