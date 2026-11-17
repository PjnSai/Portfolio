import os
from datetime import timedelta

import pytest
from django.utils import timezone

from core import passkeys
from core.models import AdminCredential, AuditLog, RateLimitBlock, Session
from tests.authenticator import SoftAuthenticator
from tests.conftest import COOKIE
from tests.notifiers import Recorder

pytestmark = pytest.mark.django_db

FAILED = {"detail": "Sign-in failed."}


@pytest.fixture
def verifications(monkeypatch):
    """Counts signature verifications, to show unknown users cost the same work."""
    calls = []
    real = passkeys.verify_authentication_response

    def counted(**kwargs):
        calls.append(kwargs["credential_public_key"])
        return real(**kwargs)

    monkeypatch.setattr(passkeys, "verify_authentication_response", counted)
    return calls


def test_sign_in_with_a_passkey(api, passkey):
    response = api.login(passkey)

    assert response.status_code == 200
    assert api.get("/session").status_code == 200
    assert AuditLog.objects.filter(event="login").count() == 1
    assert AdminCredential.objects.get().last_used_at is not None


def test_options_do_not_reveal_whether_a_passkey_exists(api, new_api, db):
    without = api.post("/login/options")
    AdminCredential.objects.create(credential_id=b"x" * 32, public_key=b"k", name="Any")
    with_one = new_api().post("/login/options")

    assert without.status_code == with_one.status_code == 200
    assert without.json().keys() == with_one.json().keys()
    assert "allowCredentials" not in with_one.json()
    assert without.json()["challenge"] != with_one.json()["challenge"]
    assert without.json()["userVerification"] == "required"


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
def test_every_failure_looks_the_same(api, new_api, passkey, verifications, case):
    authenticator, tamper = failures(passkey)[case]
    baseline_api = new_api()
    baseline = baseline_api.login(SoftAuthenticator())
    work_for_unknown_user = len(verifications)

    response = api.login(authenticator, **tamper)

    assert response.status_code == baseline.status_code == 401
    assert response.json() == baseline.json() == FAILED
    assert dict(response.headers) == dict(baseline.headers)
    assert COOKIE not in response.cookies
    assert len(verifications) == 2 * work_for_unknown_user == 2
    assert Session.objects.count() == 0


def test_no_passkey_registered_looks_the_same_as_a_wrong_one(api, db, verifications):
    response = api.login(SoftAuthenticator())

    assert response.status_code == 401
    assert response.json() == FAILED
    assert len(verifications) == 1


def test_challenge_is_single_use(api, new_api, passkey):
    options = api.post("/login/options").json()
    assertion = passkey.get(options)
    assert api.post("/login/verify", {"credential": assertion}).status_code == 200

    replay = new_api().post("/login/verify", {"credential": assertion})

    assert replay.status_code == 401


def test_challenge_not_issued_by_the_server_is_refused(api, passkey):
    options = api.post("/login/options").json()
    options["challenge"] = "bWFkZS11cC1jaGFsbGVuZ2UtbWFkZS11cC1jaGFsbGVuZ2U"

    response = api.post("/login/verify", {"credential": passkey.get(options)})

    assert response.status_code == 401


def test_login_challenge_cannot_be_used_to_confirm_a_vital_action(signed_in, passkey):
    options = signed_in.post("/login/options").json()

    response = signed_in.post("/elevate/verify", {"credential": passkey.get(options)})

    assert response.status_code == 403


def test_cloned_passkey_is_refused(api, new_api, passkey):
    passkey.sign_count = 10
    assert api.login(passkey).status_code == 200

    passkey.sign_count = 3

    assert new_api().login(passkey).status_code == 401


@pytest.mark.parametrize(
    "body",
    [{}, {"credential": "text"}, {"credential": {}}, {"credential": {"id": 1}}, []],
)
def test_malformed_sign_in_is_refused_without_an_error(api, passkey, body):
    response = api.post("/login/verify", body)

    assert response.status_code in (400, 401)
    assert "Traceback" not in response.content.decode()


def test_failures_are_audited_without_personal_data(api, passkey):
    api.login(SoftAuthenticator())

    entry = AuditLog.objects.get(event="login_failed")
    assert "@" not in str(entry.detail)
    assert "127.0.0.1" not in str(entry.detail)


def fail(new_api, times):
    return [new_api().login(SoftAuthenticator()) for _ in range(times)]


def test_repeated_failures_start_a_cool_down(new_api, passkey):
    statuses = [response.status_code for response in fail(new_api, 6)]

    assert statuses == [401, 401, 401, 401, 401, 429]


def test_cool_down_refuses_even_the_right_passkey(new_api, passkey):
    fail(new_api, 5)

    response = new_api().login(passkey)

    assert response.status_code == 429
    assert int(response["Retry-After"]) > 0
    assert new_api().post("/login/options").status_code == 429
    assert AuditLog.objects.filter(event="lockout").exists()
    assert ("lockout", {"scope": "login"}) in Recorder.sent


def test_cool_down_ends_so_the_owner_cannot_be_locked_out_for_good(new_api, passkey):
    fail(new_api, 5)
    block = RateLimitBlock.objects.get()
    assert (
        timedelta(minutes=1)
        < block.expires_at - timezone.now()
        <= timedelta(minutes=15)
    )

    RateLimitBlock.objects.update(expires_at=timezone.now() - timedelta(seconds=1))

    assert new_api().login(passkey).status_code == 200


def test_block_stores_a_keyed_hash_not_the_address(new_api, passkey):
    fail(new_api, 5)

    block = RateLimitBlock.objects.get()
    assert "127.0.0.1" not in block.key_hash
    assert len(block.key_hash) == 64


def test_successful_sign_in_clears_the_failure_count(new_api, passkey):
    fail(new_api, 4)
    assert new_api().login(passkey).status_code == 200

    statuses = [response.status_code for response in fail(new_api, 4)]

    assert statuses == [401, 401, 401, 401]


def test_failures_from_many_addresses_trip_the_global_limit(new_api, passkey, settings):
    settings.LOGIN_GLOBAL_MAX_FAILURES = 6
    statuses = []
    for n in range(8):
        api = new_api()
        options = api.post(
            "/login/options", headers={"Cf-Connecting-Ip": f"10.0.0.{n}"}
        )
        if options.status_code != 200:
            statuses.append(options.status_code)
            continue
        response = api.post(
            "/login/verify",
            {"credential": SoftAuthenticator().get(options.json())},
            headers={"Cf-Connecting-Ip": f"10.0.0.{n}"},
        )
        statuses.append(response.status_code)

    assert statuses == [401] * 6 + [429] * 2


BOOTSTRAP = {"token": "bootstrap-token"}


def bootstrap(api, authenticator, token="bootstrap-token"):
    options = api.post("/bootstrap/options", {"token": token})
    if options.status_code != 200:
        return options
    return api.post(
        "/bootstrap/verify",
        {
            "token": token,
            "name": "First key",
            "credential": authenticator.create(options.json()),
        },
    )


def test_first_passkey_is_enrolled_with_the_one_time_token(api, db):
    authenticator = SoftAuthenticator()

    response = bootstrap(api, authenticator)

    assert response.status_code == 201
    assert AdminCredential.objects.count() == 1
    assert AuditLog.objects.filter(event="passkey_added").exists()
    assert api.login(authenticator).status_code == 200


def test_bootstrap_stores_public_key_material_only(api, db):
    bootstrap(api, SoftAuthenticator())

    fields = {field.name for field in AdminCredential._meta.fields}
    assert fields == {
        "id",
        "credential_id",
        "public_key",
        "sign_count",
        "name",
        "created_at",
        "last_used_at",
    }


def test_bootstrap_needs_the_token(api, db):
    response = bootstrap(api, SoftAuthenticator(), token="guess")

    assert response.status_code == 401
    assert response.json() == FAILED
    assert AdminCredential.objects.count() == 0


def test_bootstrap_is_closed_once_a_passkey_exists(api, passkey):
    response = bootstrap(api, SoftAuthenticator())

    assert response.status_code == 401
    assert response.json() == FAILED
    assert AdminCredential.objects.count() == 1


def test_bootstrap_is_closed_when_no_token_is_configured(api, db, settings):
    settings.BOOTSTRAP_TOKEN_SHA256 = ""

    assert bootstrap(api, SoftAuthenticator(), token="").status_code in (400, 401)
    assert bootstrap(api, SoftAuthenticator()).status_code == 401
    assert AdminCredential.objects.count() == 0


def test_bootstrap_guesses_are_rate_limited(new_api, db):
    statuses = [
        bootstrap(new_api(), SoftAuthenticator(), token="guess").status_code
        for _ in range(6)
    ]

    assert statuses == [401] * 5 + [429]
