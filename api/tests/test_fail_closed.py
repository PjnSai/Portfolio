from unittest import mock

import pytest
from django.db import OperationalError, connections

from core.models import PendingAction, Project
from tests.conftest import COOKIE

pytestmark = pytest.mark.django_db

UNAVAILABLE = {"detail": "Service unavailable."}


@pytest.fixture
def database_down():
    failure = OperationalError('connection to server at "10.1.2.3" failed')
    with mock.patch.object(connections["default"], "cursor", side_effect=failure):
        yield


@pytest.fixture
def redis_down(settings):
    settings.REDIS_URL = "redis://127.0.0.1:1/0"


def assert_closed(response):
    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    assert COOKIE not in response.cookies
    assert "10.1.2.3" not in response.content.decode()


def test_signed_in_admin_is_refused_when_the_database_is_down(signed_in, database_down):
    assert_closed(signed_in.get("/session"))
    assert_closed(signed_in.get("/audit"))
    assert_closed(signed_in.post("/logout"))


def test_sign_in_is_refused_when_the_database_is_down(api, passkey):
    options = api.post("/login/options").json()
    assertion = passkey.get(options)

    failure = OperationalError("down")
    with mock.patch.object(connections["default"], "cursor", side_effect=failure):
        response = api.post("/login/verify", {"credential": assertion})

    assert_closed(response)


def test_vital_action_is_refused_when_the_database_is_down(elevated):
    project = Project.objects.create(slug="demo", title="Demo")
    body = {
        "kind": "permanent_delete",
        "payload": {"entity": "project", "id": str(project.id)},
    }

    failure = OperationalError("down")
    with mock.patch.object(connections["default"], "cursor", side_effect=failure):
        response = elevated.post("/vital-actions/request", body)

    assert_closed(response)
    assert PendingAction.objects.count() == 0


def test_sign_in_is_refused_when_redis_is_down(api, passkey, redis_down):
    assert_closed(api.post("/login/options"))
    assert_closed(api.post("/login/verify", {"credential": {"id": "x"}}))


def test_signed_in_admin_is_refused_when_redis_is_down(signed_in, settings):
    settings.REDIS_URL = "redis://127.0.0.1:1/0"

    assert_closed(signed_in.get("/session"))
    assert_closed(signed_in.post("/elevate/options"))
    assert_closed(signed_in.post("/sessions/revoke-all"))


def test_admin_is_refused_when_redis_is_not_configured(signed_in, settings):
    settings.REDIS_URL = ""

    assert_closed(signed_in.get("/session"))


def test_public_status_still_answers_when_both_are_down(
    client, database_down, redis_down
):
    assert client.get("/api/v1/status").status_code == 200
    assert client.get("/healthz").status_code == 200


def test_unexpected_error_gives_a_plain_500(signed_in, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("secret detail at /srv/app/core/views.py")

    monkeypatch.setattr("core.audit.verify_chain", broken)
    signed_in.client.raise_request_exception = False

    response = signed_in.get("/audit/verify")

    assert response.status_code == 500
    assert "secret detail" not in response.content.decode()
    assert "Traceback" not in response.content.decode()
