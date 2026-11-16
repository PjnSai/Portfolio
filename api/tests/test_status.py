import pytest
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from rest_framework.permissions import IsAuthenticated
from rest_framework.settings import api_settings


def test_status_returns_ok(client):
    response = client.get("/api/v1/status")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response["Cache-Control"] == "no-store"


def test_healthz_returns_ok(client):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_django_admin_is_not_installed(client):
    assert "django.contrib.admin" not in settings.INSTALLED_APPS
    assert client.get("/admin/").status_code == 404


def test_api_denies_by_default():
    assert api_settings.DEFAULT_PERMISSION_CLASSES == [IsAuthenticated]


def test_debug_is_off_and_errors_are_plain(client):
    response = client.get("/api/v1/does-not-exist")

    assert settings.DEBUG is False
    assert response.status_code == 404
    assert b"Traceback" not in response.content
    assert b"Django" not in response.content


def test_responses_carry_baseline_security_headers(client):
    response = client.get("/api/v1/status")

    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["X-Frame-Options"] == "DENY"


def test_missing_secret_refuses_to_start(monkeypatch):
    from config.settings import required_env

    monkeypatch.delenv("DJANGO_SECRET_KEY")

    with pytest.raises(ImproperlyConfigured):
        required_env("DJANGO_SECRET_KEY")
