import hashlib

import pytest
from django.utils import timezone

from core.models import AuditLog, Session
from tests.conftest import COOKIE, age_sessions
from tests.notifiers import Recorder

pytestmark = pytest.mark.django_db


def test_cookie_flags(api, passkey):
    response = api.login(passkey)
    cookie = response.cookies[COOKIE]

    assert cookie["secure"] is True
    assert cookie["httponly"] is True
    assert cookie["samesite"] == "Strict"
    assert cookie["path"] == "/"
    assert cookie["domain"] == ""
    assert cookie["max-age"] == ""
    assert cookie["expires"] == ""
    assert list(response.cookies) == [COOKIE]


def test_session_id_is_256_bits_and_only_its_hash_is_stored(signed_in):
    token = signed_in.cookie
    session = Session.objects.get()

    assert len(token) >= 43
    assert session.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(vars(session))


def test_session_id_supplied_before_login_is_never_adopted(api, passkey):
    planted = "A" * 43
    api.set_cookie(planted)

    assert api.login(passkey).status_code == 200

    assert api.cookie != planted
    assert not Session.objects.filter(
        token_hash=hashlib.sha256(planted.encode()).hexdigest()
    ).exists()
    api.set_cookie(planted)
    assert api.get("/session").status_code == 401


def test_login_issues_a_new_session_and_retires_the_old_one(signed_in, passkey):
    first = signed_in.cookie

    assert signed_in.login(passkey).status_code == 200
    second = signed_in.cookie

    assert first != second
    assert signed_in.get("/session").status_code == 200
    signed_in.set_cookie(first)
    assert signed_in.get("/session").status_code == 401


def test_session_rotates_on_privilege_change(signed_in, passkey):
    before = signed_in.cookie
    started = Session.objects.get().authenticated_at

    assert signed_in.elevate(passkey).status_code == 200
    after = signed_in.cookie

    assert before != after
    current = Session.objects.get(revoked_at=None)
    assert current.authenticated_at == started
    signed_in.set_cookie(before)
    assert signed_in.get("/session").status_code == 401


def test_idle_timeout_is_fifteen_minutes(signed_in):
    age_sessions(minutes=14)
    assert signed_in.get("/session").status_code == 200

    age_sessions(minutes=16)
    assert signed_in.get("/session").status_code == 401


def test_absolute_timeout_is_eight_hours_whatever_the_activity(signed_in, passkey):
    for _ in range(40):
        age_sessions(minutes=12)
        last = signed_in.get("/session")
        if last.status_code != 200:
            break

    assert last.status_code == 401
    assert Session.objects.count() == 1


def test_rotation_does_not_extend_the_absolute_timeout(signed_in, passkey):
    age_sessions(hours=7, minutes=55)
    Session.objects.update(last_seen_at=timezone.now())
    assert signed_in.elevate(passkey).status_code == 200

    age_sessions(minutes=10)

    assert signed_in.get("/session").status_code == 401


def test_logout_ends_the_session_and_clears_the_cookie(signed_in):
    token = signed_in.cookie

    response = signed_in.post("/logout")

    assert response.status_code == 200
    assert response.cookies[COOKIE].value == ""
    assert response.cookies[COOKIE]["max-age"] == 0
    signed_in.set_cookie(token)
    assert signed_in.get("/session").status_code == 401


def test_revoke_all_ends_every_session(elevated, new_api, passkey):
    other = new_api()
    assert other.login(passkey).status_code == 200
    assert other.get("/session").status_code == 200

    response = elevated.post("/sessions/revoke-all")

    assert response.status_code == 200
    assert response.cookies[COOKIE].value == ""
    assert other.get("/session").status_code == 401
    assert elevated.get("/session").status_code == 401
    assert AuditLog.objects.filter(event="sessions_revoked").exists()
    assert Recorder.sent[-1][0] == "sessions_revoked"


def test_revoke_all_needs_a_fresh_passkey_confirmation(signed_in):
    response = signed_in.post("/sessions/revoke-all")

    assert response.status_code == 403
    assert signed_in.get("/session").status_code == 200


def test_session_endpoint_reports_state_for_the_admin_banner(signed_in, passkey):
    body = signed_in.get("/session").json()

    assert body["csrf_token"] == signed_in.csrf
    assert body["elevated"] is False
    assert body["pending_actions"] == 0

    signed_in.elevate(passkey)

    assert signed_in.get("/session").json()["elevated"] is True


def test_csrf_tokens_differ_between_sessions(signed_in, new_api, passkey):
    other = new_api()
    other.login(passkey)

    assert other.csrf != signed_in.csrf
    assert len(signed_in.csrf) >= 43


def test_failed_passkey_confirmation_does_not_elevate(signed_in, passkey):
    response = signed_in.elevate(passkey, origin="https://evil.test")

    assert response.status_code == 403
    assert signed_in.get("/session").json()["elevated"] is False


def test_confirmation_challenge_is_bound_to_the_session(signed_in, new_api, passkey):
    other = new_api()
    other.login(passkey)
    options = other.post("/elevate/options").json()

    response = signed_in.post("/elevate/verify", {"credential": passkey.get(options)})

    assert response.status_code == 403
