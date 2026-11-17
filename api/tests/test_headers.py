import pytest

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


@pytest.mark.parametrize(
    "path", ["/api/v1/status", "/healthz", "/api/v1/missing", "/api/v1/admin/session"]
)
def test_every_response_carries_the_security_headers(client, path):
    response = client.get(path)

    for name, value in EXPECTED.items():
        assert response[name] == value, name
    assert "camera=()" in response["Permissions-Policy"]
    assert "geolocation=()" in response["Permissions-Policy"]


def test_headers_are_defined_in_one_place():
    assert EXPECTED.items() <= HEADERS.items()


def test_responses_are_not_cached_unless_a_view_says_so(client):
    assert client.get("/api/v1/missing")["Cache-Control"] == "no-store"
    assert client.get("/api/v1/admin/session")["Cache-Control"] == "no-store"


def test_no_framework_or_version_headers(client):
    response = client.get("/api/v1/status")

    for name in ("Server", "X-Powered-By"):
        assert name not in response
