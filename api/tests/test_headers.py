import pytest
from django.conf import settings

from core.headers import HEADERS

EXPECTED = {
    "Content-Security-Policy": (
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'none'"
    ),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}

PATHS = ["/api/v1/status", "/healthz", "/api/v1/missing", "/api/v1/admin/session"]


@pytest.mark.parametrize("path", PATHS)
def test_every_response_carries_the_security_headers(client, path):
    response = client.get(path, secure=True)

    for name, value in EXPECTED.items():
        assert response[name] == value, name
    assert "camera=()" in response["Permissions-Policy"]
    assert "geolocation=()" in response["Permissions-Policy"]


@pytest.mark.parametrize("path", PATHS)
def test_https_behind_the_proxy_gets_hsts(client, path):
    # Cloud Run ends TLS and passes the scheme on in X-Forwarded-Proto.
    response = client.get(path, headers={"X-Forwarded-Proto": "https"})

    assert (
        response["Strict-Transport-Security"] == EXPECTED["Strict-Transport-Security"]
    )


def test_django_sets_the_headers_it_supports():
    assert settings.MIDDLEWARE[0] == "django.middleware.security.SecurityMiddleware"
    assert "django.middleware.clickjacking.XFrameOptionsMiddleware" in (
        settings.MIDDLEWARE
    )
    assert settings.SECURE_PROXY_SSL_HEADER == ("HTTP_X_FORWARDED_PROTO", "https")


def test_custom_headers_only_add_what_django_lacks():
    assert set(HEADERS) == {
        "Content-Security-Policy",
        "Cross-Origin-Resource-Policy",
        "Permissions-Policy",
    }
    assert HEADERS.items() <= EXPECTED.items() | {
        ("Permissions-Policy", HEADERS["Permissions-Policy"])
    }


def test_responses_are_not_cached_unless_a_view_says_so(client):
    assert client.get("/api/v1/missing")["Cache-Control"] == "no-store"
    assert client.get("/api/v1/admin/session")["Cache-Control"] == "no-store"


def test_no_framework_or_version_headers(client):
    response = client.get("/api/v1/status")

    for name in ("Server", "X-Powered-By"):
        assert name not in response
