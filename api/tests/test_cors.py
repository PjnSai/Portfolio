"""The admin pages are served by Cloudflare Pages and call the API on another
host of the same domain. Only the site's own origin may read admin responses."""

import pytest

from tests.conftest import ADMIN, ORIGIN

pytestmark = pytest.mark.django_db

PREFLIGHT = {
    "Origin": ORIGIN,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type,x-csrf-token",
    "Sec-Fetch-Site": "same-site",
}


def preflight(client, path=ADMIN + "/login/options", **headers):
    sent = {**PREFLIGHT, **headers}
    sent = {k: v for k, v in sent.items() if v is not None}
    return client.options(path, secure=True, headers=sent)


def test_preflight_from_the_site_is_answered(client):
    response = preflight(client)

    assert response.status_code == 204
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert response["Access-Control-Allow-Credentials"] == "true"
    assert "POST" in response["Access-Control-Allow-Methods"]
    assert "x-csrf-token" in response["Access-Control-Allow-Headers"].lower()
    assert "Origin" in response["Vary"]
    assert response["Content-Security-Policy"].startswith("default-src 'none'")


def test_preflight_needs_no_access_token_or_session(client):
    # Cloudflare Access passes preflights through; they carry no credentials.
    assert preflight(client, ADMIN + "/no-such-route").status_code == 204


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.test"},
        {"Origin": "https://other.portfolio.test"},
        {"Origin": "null"},
        {"Origin": None},
        {"Access-Control-Request-Method": "TRACE"},
        {"Access-Control-Request-Method": None},
        {"Access-Control-Request-Headers": "content-type,authorization"},
    ],
)
def test_other_preflights_are_refused(client, headers):
    response = preflight(client, **headers)

    assert response.status_code == 403
    assert "Access-Control-Allow-Origin" not in response


def test_preflight_is_refused_when_the_site_origin_is_not_set(client, settings):
    settings.SITE_ORIGIN = ""

    response = preflight(client, Origin="")

    assert response.status_code == 403
    assert "Access-Control-Allow-Origin" not in response


def test_public_routes_send_no_cors_headers(client):
    response = client.get("/api/v1/site", headers={"Origin": ORIGIN})

    assert "Access-Control-Allow-Origin" not in response
    assert preflight(client, "/api/v1/site").status_code == 403


def test_admin_responses_to_the_site_carry_cors_headers(signed_in):
    response = signed_in.get("/session", headers={"Sec-Fetch-Site": "same-site"})

    assert response.status_code == 200
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert response["Access-Control-Allow-Credentials"] == "true"
    assert "Origin" in response["Vary"]


def test_refusals_to_the_site_carry_cors_headers_so_the_page_can_read_them(api):
    response = api.get("/session", headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403
    assert response["Access-Control-Allow-Origin"] == ORIGIN


def cors_headers(response):
    return [
        name
        for name, _ in response.items()
        if name.lower().startswith("access-control-")
    ]


OTHER_ORIGINS = [
    "https://evil.test",
    "https://portfolio.test.evil.test",
    "https://evil.portfolio.test",
    "http://portfolio.test",
    "https://portfolio.test:8443",
    "https://PORTFOLIO.test",
    "https://portfolio.test/",
    "null",
    "*",
]


@pytest.mark.parametrize("origin", OTHER_ORIGINS)
def test_admin_responses_to_another_origin_carry_none(signed_in, origin):
    response = signed_in.get("/session", headers={"Origin": origin})

    assert cors_headers(response) == []
    assert "Origin" in response["Vary"]


@pytest.mark.parametrize("origin", OTHER_ORIGINS)
def test_preflights_from_another_origin_carry_none(client, origin):
    response = preflight(client, Origin=origin)

    assert response.status_code == 403
    assert cors_headers(response) == []


def test_allowed_origin_is_the_site_origin_exactly_never_a_wildcard(signed_in):
    for response in (
        signed_in.get("/session", headers={"Sec-Fetch-Site": "same-site"}),
        preflight(signed_in.client),
    ):
        assert response["Access-Control-Allow-Origin"] == ORIGIN
        assert response["Access-Control-Allow-Origin"] != "*"
        assert response["Access-Control-Allow-Credentials"] == "true"
        assert "Origin" in response["Vary"]


def test_preflight_allows_only_the_methods_and_headers_the_admin_sends(client):
    response = preflight(client)

    assert response["Access-Control-Allow-Methods"] == "GET, POST, PATCH"
    assert response["Access-Control-Allow-Headers"] == "content-type, x-csrf-token"


@pytest.mark.parametrize("method", ["PUT", "DELETE", "OPTIONS", "CONNECT"])
def test_preflight_refuses_methods_the_admin_never_sends(client, method):
    response = preflight(client, **{"Access-Control-Request-Method": method})

    assert response.status_code == 403
    assert cors_headers(response) == []


def test_credentials_are_never_allowed_without_the_site_origin(signed_in):
    response = signed_in.get("/session", headers={"Origin": None})

    assert cors_headers(response) == []
