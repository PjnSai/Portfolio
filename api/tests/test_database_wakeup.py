"""The database may be asleep (Neon's free plan stops it after five idle
minutes). A connection gets about 10 seconds and one more try; after that the
admin and the forms answer 503."""

import time
from unittest import mock

import pytest
from django.db import OperationalError, connections
from django.db.backends.postgresql import base as postgresql

from config.settings import database_from_url
from tests.conftest import COOKIE
from tests.test_contact import submit

URL = "postgres://u:p@db.example.test:5432/portfolio"
UNAVAILABLE = {"detail": "Service unavailable."}


def asleep(times):
    """The driver's connect fails `times` times, then works as before."""
    real = postgresql.DatabaseWrapper.get_new_connection
    calls = []

    def connect(self, params):
        calls.append(params)
        if len(calls) <= times:
            raise postgresql.Database.OperationalError("the database is waking")
        return real(self, params)

    return calls, mock.patch.object(
        postgresql.DatabaseWrapper, "get_new_connection", connect
    )


def fresh_connection():
    """A connection like the app's own, not yet connected."""
    return connections.create_connection("default")


def test_the_connect_timeout_is_about_ten_seconds():
    config = database_from_url(URL)
    assert config["OPTIONS"]["connect_timeout"] == 10
    assert config["ENGINE"] == "config.database"


def test_ssl_is_still_required_when_the_url_asks():
    config = database_from_url(URL + "?sslmode=require")
    assert config["OPTIONS"] == {"sslmode": "require", "connect_timeout": 10}


def test_the_app_uses_the_retrying_backend(settings):
    assert settings.DATABASES["default"]["ENGINE"] == "config.database"
    assert settings.DATABASES["default"]["OPTIONS"]["connect_timeout"] == 10


@pytest.mark.django_db
def test_a_first_failure_then_success_connects():
    calls, patch = asleep(1)
    connection = fresh_connection()
    with patch:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            assert cursor.fetchone() == (1,)
    connection.close()
    assert len(calls) == 2


@pytest.mark.django_db
def test_two_failures_raise_and_stop_trying():
    calls, patch = asleep(2)
    connection = fresh_connection()
    with patch, pytest.raises(OperationalError):
        connection.ensure_connection()
    assert len(calls) == 2


@pytest.mark.django_db
def test_a_connection_that_works_is_made_once_without_waiting():
    calls, patch = asleep(0)
    connection = fresh_connection()
    started = time.monotonic()
    with patch:
        connection.ensure_connection()
    connection.close()
    assert len(calls) == 1
    assert time.monotonic() - started < 2


def reconnecting(spare):
    """The app's connection behaves as if it had to connect again, through
    `spare` (the test's own connection stays open inside its transaction)."""
    return mock.patch.object(
        connections["default"], "ensure_connection", spare.ensure_connection
    )


@pytest.fixture
def database_asleep():
    """Every new connection fails."""
    calls, patch = asleep(1_000)
    with patch, reconnecting(fresh_connection()):
        yield calls


@pytest.mark.django_db
def test_two_failures_close_the_admin_with_503(signed_in, database_asleep):
    response = signed_in.get("/session")

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    assert COOKIE not in response.cookies
    assert len(database_asleep) == 2


@pytest.mark.django_db
def test_two_failures_close_the_contact_form_with_503(database_asleep):
    response = submit()

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE


@pytest.mark.django_db
def test_a_waking_database_still_answers_the_admin(signed_in):
    calls, patch = asleep(1)
    spare = fresh_connection()
    with patch, reconnecting(spare):
        response = signed_in.get("/session")
    spare.close()
    assert response.status_code == 200
    assert len(calls) == 2
