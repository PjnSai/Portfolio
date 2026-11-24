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


# The contact form's POST: the one public route the site's pages call

CONTACT = "/api/v1/contact"
CONTACT_PREFLIGHT = {
    "Origin": ORIGIN,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
    "Sec-Fetch-Site": "same-site",
}


def contact_preflight(client, path=CONTACT, **headers):
    sent = {**CONTACT_PREFLIGHT, **headers}
    sent = {k: v for k, v in sent.items() if v is not None}
    return client.options(path, secure=True, headers=sent)


def test_the_contact_preflight_from_the_site_is_answered_narrowly(client):
    response = contact_preflight(client)

    assert response.status_code == 204
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert response["Access-Control-Allow-Methods"] == "POST"
    assert response["Access-Control-Allow-Headers"] == "Content-Type"
    assert response["Access-Control-Max-Age"] == "120"
    assert "Origin" in response["Vary"]


def test_the_contact_preflight_allows_no_credentials(client):
    response = contact_preflight(client)

    assert "Access-Control-Allow-Credentials" not in response
    assert response["Access-Control-Allow-Origin"] != "*"


def test_the_contact_preflight_cache_is_short(client):
    assert int(contact_preflight(client)["Access-Control-Max-Age"]) <= 300


@pytest.mark.parametrize("origin", OTHER_ORIGINS)
def test_the_contact_preflight_from_another_origin_is_refused(client, origin):
    response = contact_preflight(client, Origin=origin)

    assert response.status_code == 403
    assert cors_headers(response) == []


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": None},
        {"Access-Control-Request-Method": "GET"},
        {"Access-Control-Request-Method": "PUT"},
        {"Access-Control-Request-Method": "DELETE"},
        {"Access-Control-Request-Method": None},
        {"Access-Control-Request-Headers": "content-type,x-csrf-token"},
        {"Access-Control-Request-Headers": "content-type,authorization"},
        {"Access-Control-Request-Headers": "x-requested-with"},
    ],
)
def test_other_contact_preflights_are_refused(client, headers):
    response = contact_preflight(client, **headers)

    assert response.status_code == 403
    assert cors_headers(response) == []


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/site",
        "/api/v1/status",
        "/api/v1/contact/",
        "/api/v1/contact/start",
        "/api/v1/contact/challenge",
        "/api/v1/contactx",
        "/api/v1/media/00000000000000000000000000000000-480.webp",
        "/healthz",
    ],
)
def test_no_other_public_route_answers_a_preflight(client, path):
    response = contact_preflight(client, path=path)

    assert response.status_code == 403
    assert cors_headers(response) == []


def test_the_admin_preflight_is_not_loosened_by_the_contact_rule(client):
    response = preflight(client, Origin="https://evil.test")

    assert response.status_code == 403
    assert preflight(client).status_code == 204
    # The admin rule still wants credentials; the contact rule never sends them.
    assert preflight(client)["Access-Control-Allow-Credentials"] == "true"
    assert "Access-Control-Allow-Credentials" not in contact_preflight(client)


def test_a_contact_response_to_the_site_can_be_read_by_the_page(client):
    response = client.post(
        CONTACT,
        "{}",
        content_type="application/json",
        secure=True,
        headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-site"},
    )

    assert response.status_code == 400
    assert response["Access-Control-Allow-Origin"] == ORIGIN
    assert "Access-Control-Allow-Credentials" not in response
    assert "Origin" in response["Vary"]


@pytest.mark.parametrize("origin", OTHER_ORIGINS)
def test_a_contact_response_to_another_origin_carries_none(client, origin):
    response = client.post(
        CONTACT,
        "{}",
        content_type="application/json",
        secure=True,
        headers={"Origin": origin, "Sec-Fetch-Site": "cross-site"},
    )

    assert response.status_code == 403
    assert cors_headers(response) == []
    assert "Origin" in response["Vary"]


def test_other_public_responses_still_send_no_cors_headers(client):
    for path in ("/api/v1/site", "/api/v1/status", "/healthz"):
        response = client.get(path, secure=True, headers={"Origin": ORIGIN})

        assert cors_headers(response) == [], path


def test_the_page_may_read_how_long_to_wait_after_a_rate_limit(client):
    response = client.post(
        CONTACT,
        "{}",
        content_type="application/json",
        secure=True,
        headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-site"},
    )

    assert response["Access-Control-Expose-Headers"] == "Retry-After"


def test_nothing_is_exposed_to_another_origin(client):
    response = client.post(
        CONTACT,
        "{}",
        content_type="application/json",
        secure=True,
        headers={"Origin": "https://evil.test", "Sec-Fetch-Site": "cross-site"},
    )

    assert "Access-Control-Expose-Headers" not in response
