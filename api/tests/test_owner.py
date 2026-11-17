"""One owner, for good: the account, bootstrap, Access identity and recovery."""

import hashlib

import pytest
from django.db import IntegrityError, transaction

from core import admin_urls
from core.models import AdminCredential, AuditLog, Owner, PendingAction, Session
from tests.authenticator import SoftAuthenticator
from tests.conftest import COOKIE
from tests.notifiers import Recorder
from tests.test_login import BOOTSTRAP, FAILED, bootstrap
from tests.test_routes import ALL

pytestmark = pytest.mark.django_db

FORBIDDEN = {"detail": "Forbidden."}


def refused_by_database(create):
    with pytest.raises(IntegrityError), transaction.atomic():
        create()


# One owner account


def test_exactly_one_owner_exists():
    assert Owner.objects.count() == 1


def test_database_refuses_a_second_owner():
    refused_by_database(lambda: Owner.objects.create())
    refused_by_database(lambda: Owner.objects.create(singleton=False))

    assert Owner.objects.count() == 1


def test_owner_row_holds_no_personal_data_or_secret():
    assert {field.name for field in Owner._meta.fields} == {
        "id",
        "singleton",
        "created_at",
        "bootstrapped_at",
        "recovery_key_hash",
    }


def test_session_cannot_exist_without_the_owner():
    refused_by_database(lambda: Session.objects.create(token_hash="a" * 64))


def test_sessions_belong_to_the_owner(signed_in):
    assert Session.objects.get().owner == Owner.objects.get()


def test_no_route_creates_an_account(api):
    paths = " ".join(str(pattern.pattern) for pattern in admin_urls.urlpatterns)
    for word in ("user", "owner", "account", "register", "signup", "sign-up"):
        assert word not in paths

    bootstrap(api, SoftAuthenticator())

    assert Owner.objects.count() == 1


# Bootstrap closes for good


def test_bootstrap_token_replay_is_refused_after_enrolment(api, new_api):
    assert bootstrap(api, SoftAuthenticator()).status_code == 201

    replay = bootstrap(new_api(), SoftAuthenticator())

    assert replay.status_code == 401
    assert replay.json() == FAILED
    assert AdminCredential.objects.count() == 1
    assert Owner.objects.get().bootstrapped_at is not None


def test_the_same_bootstrap_request_cannot_be_sent_twice(api, new_api):
    options = api.post("/bootstrap/options", BOOTSTRAP).json()
    body = {**BOOTSTRAP, "credential": SoftAuthenticator().create(options)}
    assert api.post("/bootstrap/verify", body).status_code == 201

    assert new_api().post("/bootstrap/verify", body).status_code == 401
    assert AdminCredential.objects.count() == 1


def test_bootstrap_started_before_enrolment_cannot_finish_after_it(api, new_api):
    late = new_api()
    options = late.post("/bootstrap/options", BOOTSTRAP).json()
    assert bootstrap(api, SoftAuthenticator()).status_code == 201

    response = late.post(
        "/bootstrap/verify",
        {**BOOTSTRAP, "credential": SoftAuthenticator().create(options)},
    )

    assert response.status_code == 401
    assert AdminCredential.objects.count() == 1


def test_bootstrap_stays_closed_when_every_passkey_is_gone(api, new_api):
    assert bootstrap(api, SoftAuthenticator()).status_code == 201
    AdminCredential.objects.all().delete()

    response = bootstrap(new_api(), SoftAuthenticator())

    assert response.status_code == 401
    assert response.json() == FAILED
    assert AdminCredential.objects.count() == 0


# Cloudflare Access identity


@pytest.mark.parametrize("method,path,level", ALL)
def test_valid_access_token_for_another_email_is_refused(
    elevated, access, method, path, level
):
    other = access(email="someone-else@portfolio.test")

    response = elevated.request(
        method, path, headers={"Cf-Access-Jwt-Assertion": other}
    )

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


@pytest.mark.parametrize(
    "email",
    [
        "Owner@portfolio.test",
        "owner@PORTFOLIO.test",
        "owner@portfolio.test ",
        " owner@portfolio.test",
        "owner@portfolio.test.evil.test",
        "xowner@portfolio.test",
        "owner+other@portfolio.test",
        "",
        ["owner@portfolio.test"],
    ],
)
def test_access_email_must_equal_the_owner_email_exactly(signed_in, access, email):
    response = signed_in.get(
        "/session", headers={"Cf-Access-Jwt-Assertion": access(email=email)}
    )

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


# Revoke everything, and the recovery key


@pytest.fixture
def owned(api):
    """The owner enrolled through bootstrap, holding the recovery key."""
    authenticator = SoftAuthenticator()
    response = bootstrap(api, authenticator)
    assert response.status_code == 201
    return authenticator, response.json()["recovery_key"]


def recover(api, key, authenticator):
    options = api.post("/recovery/options", {"key": key})
    if options.status_code != 200:
        return options
    return api.post(
        "/recovery/verify",
        {
            "key": key,
            "name": "Replacement",
            "credential": authenticator.create(options.json()),
        },
    )


def live_sessions():
    return Session.objects.filter(revoked_at=None).count()


def test_bootstrap_hands_out_the_recovery_key_once(owned):
    _, key = owned

    stored = Owner.objects.get().recovery_key_hash
    assert len(key) >= 43
    assert stored == hashlib.sha256(key.encode()).hexdigest()
    assert key not in str(list(AuditLog.objects.values_list("detail", flat=True)))
    assert key not in str(Recorder.sent)


def test_revoke_everything_ends_sessions_passkeys_and_pending_actions(
    api, new_api, owned
):
    authenticator, _ = owned
    other = new_api()
    assert other.login(authenticator).status_code == 200
    assert api.login(authenticator).status_code == 200
    assert api.elevate(authenticator).status_code == 200
    requested = api.post(
        "/vital-actions/request", {"kind": "add_passkey", "payload": {"name": "New"}}
    )
    assert requested.status_code == 201

    response = api.post("/access/revoke-all")

    assert response.status_code == 200
    assert response.cookies[COOKIE].value == ""
    assert AdminCredential.objects.count() == 0
    assert live_sessions() == 0
    assert PendingAction.objects.get().status == "cancelled"
    assert other.get("/session").status_code == 401
    assert new_api().login(authenticator).status_code == 401
    assert AuditLog.objects.filter(event="access_revoked").exists()
    assert Recorder.sent[-1][0] == "access_revoked"


def test_revoke_everything_needs_a_fresh_passkey_confirmation(signed_in):
    response = signed_in.post("/access/revoke-all")

    assert response.status_code == 403
    assert AdminCredential.objects.count() == 1
    assert signed_in.get("/session").status_code == 200


def test_revoke_everything_works_even_if_the_notice_cannot_be_sent(elevated, settings):
    settings.NOTIFIERS = ["tests.notifiers.Broken"]

    assert elevated.post("/access/revoke-all").status_code == 200
    assert AdminCredential.objects.count() == 0
    assert live_sessions() == 0


def test_bootstrap_stays_closed_after_everything_is_revoked(api, new_api, owned):
    authenticator, _ = owned
    api.login(authenticator)
    api.elevate(authenticator)
    assert api.post("/access/revoke-all").status_code == 200

    response = bootstrap(new_api(), SoftAuthenticator())

    assert response.status_code == 401
    assert AdminCredential.objects.count() == 0


def test_recovery_key_replaces_every_passkey_and_ends_every_session(
    api, new_api, owned
):
    lost, key = owned
    assert api.login(lost).status_code == 200
    assert api.elevate(lost).status_code == 200
    api.post(
        "/vital-actions/request", {"kind": "add_passkey", "payload": {"name": "New"}}
    )
    replacement = SoftAuthenticator()

    response = recover(new_api(), key, replacement)

    assert response.status_code == 201
    assert AdminCredential.objects.get().name == "Replacement"
    assert api.get("/session").status_code == 401
    assert live_sessions() == 0
    assert PendingAction.objects.get().status == "cancelled"
    assert new_api().login(lost).status_code == 401
    assert new_api().login(replacement).status_code == 200
    assert AuditLog.objects.filter(event="recovery_used").exists()
    assert "recovery_used" in [event for event, _ in Recorder.sent]


def test_recovery_works_after_everything_is_revoked(api, new_api, owned):
    authenticator, key = owned
    api.login(authenticator)
    api.elevate(authenticator)
    assert api.post("/access/revoke-all").status_code == 200
    replacement = SoftAuthenticator()

    assert recover(new_api(), key, replacement).status_code == 201
    assert new_api().login(replacement).status_code == 200


def test_recovery_key_works_once_and_a_new_one_is_issued(new_api, owned):
    _, key = owned
    first = recover(new_api(), key, SoftAuthenticator())
    fresh = first.json()["recovery_key"]

    replay = recover(new_api(), key, SoftAuthenticator())

    assert fresh != key
    assert replay.status_code == 401
    assert replay.json() == FAILED
    assert AdminCredential.objects.count() == 1
    assert recover(new_api(), fresh, SoftAuthenticator()).status_code == 201


def test_wrong_recovery_key_looks_like_any_failed_sign_in(new_api, owned):
    response = recover(new_api(), "guess", SoftAuthenticator())

    assert response.status_code == 401
    assert response.json() == FAILED
    assert AdminCredential.objects.get().name == "First key"
    assert AuditLog.objects.filter(event="recovery_failed").exists()


def test_recovery_is_closed_before_a_key_exists(api, passkey):
    assert Owner.objects.get().recovery_key_hash == ""

    for key in ("", "guess", hashlib.sha256(b"").hexdigest()):
        assert recover(api, key, SoftAuthenticator()).status_code in (400, 401)
    assert AdminCredential.objects.count() == 1


def test_recovery_guesses_are_rate_limited(new_api, owned):
    statuses = [
        recover(new_api(), "guess", SoftAuthenticator()).status_code for _ in range(6)
    ]

    assert statuses == [401] * 5 + [429]


def test_recovery_is_refused_if_the_alert_cannot_be_sent(new_api, owned, settings):
    _, key = owned
    settings.NOTIFIERS = ["tests.notifiers.Broken"]

    response = recover(new_api(), key, SoftAuthenticator())

    assert response.status_code == 503
    assert AdminCredential.objects.get().name == "First key"

    settings.NOTIFIERS = ["tests.notifiers.Recorder"]
    assert recover(new_api(), key, SoftAuthenticator()).status_code == 201
