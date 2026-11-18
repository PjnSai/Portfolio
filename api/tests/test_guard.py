import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from tests.conftest import access_token

pytestmark = pytest.mark.django_db

FORBIDDEN = {"detail": "Forbidden."}


def test_request_with_everything_in_order_passes(api):
    assert api.post("/login/options").status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": None},
        {"Origin": "https://evil.test"},
        {"Origin": "http://portfolio.test"},
        {"Origin": "https://portfolio.test.evil.test"},
        {"Origin": "null"},
        {"Sec-Fetch-Site": None},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "none"},
        {"Sec-Fetch-Site": "same-site", "Origin": "https://other.portfolio.test"},
    ],
)
def test_state_changing_request_from_elsewhere_is_refused(api, headers):
    response = api.post("/login/options", headers=headers)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_the_site_may_write_from_its_own_origin_on_a_sibling_host(api):
    # The site and the API are on hosts of one domain, so the browser says
    # same-site; the Origin must still be exactly the site's.
    assert (
        api.post("/login/options", headers={"Sec-Fetch-Site": "same-site"}).status_code
        == 200
    )


@pytest.mark.parametrize("site", ["cross-site", "none"])
def test_cross_site_read_of_admin_is_refused(signed_in, site):
    response = signed_in.get("/session", headers={"Sec-Fetch-Site": site})

    assert response.status_code == 403


@pytest.mark.parametrize(
    "origin", ["https://evil.test", "https://other.portfolio.test", "null"]
)
def test_admin_read_from_another_origin_is_refused(signed_in, origin):
    response = signed_in.get(
        "/session", headers={"Sec-Fetch-Site": "same-site", "Origin": origin}
    )

    assert response.status_code == 403


@pytest.mark.parametrize("origin", ["https://portfolio.test", None])
def test_admin_read_from_the_site_is_allowed(signed_in, origin):
    # An image tag sends no Origin; a fetch from the site sends the site's.
    response = signed_in.get(
        "/session", headers={"Sec-Fetch-Site": "same-site", "Origin": origin}
    )

    assert response.status_code == 200


def bad_tokens(key, make):
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(time.time())
    unsigned = jwt.encode(
        {"aud": ["test-audience-tag"], "exp": now + 300}, None, algorithm="none"
    )
    return {
        "missing": None,
        "empty": "",
        "garbage": "not-a-token",
        "wrong signature": access_token(other_key),
        "wrong audience": make(aud=["another-application"]),
        "expired": make(iat=now - 900, exp=now - 600),
        "wrong issuer": make(iss="https://attacker.cloudflareaccess.test"),
        "wrong email": make(email="someone-else@portfolio.test"),
        "no email": make(email=None),
        "unsigned": unsigned,
    }


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "empty",
        "garbage",
        "wrong signature",
        "wrong audience",
        "expired",
        "wrong issuer",
        "wrong email",
        "no email",
        "unsigned",
    ],
)
def test_bad_access_token_is_refused(api, access, access_key, case):
    token = bad_tokens(access_key, access)[case]

    for response in (
        api.post("/login/options", headers={"Cf-Access-Jwt-Assertion": token}),
        api.get("/session", headers={"Cf-Access-Jwt-Assertion": token}),
    ):
        assert response.status_code == 403
        assert response.json() == FORBIDDEN


def test_access_token_is_checked_on_every_request(signed_in):
    assert signed_in.get("/session").status_code == 200

    response = signed_in.get("/session", headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403


def test_unknown_admin_path_does_not_reveal_whether_it_exists(api):
    response = api.get("/no-such-route", headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


def test_refused_when_signing_keys_cannot_be_fetched(api, monkeypatch):
    def unreachable(token):
        raise ConnectionError("certs endpoint is down")

    monkeypatch.setattr("core.access.fetch_signing_key", unreachable)

    assert api.post("/login/options").status_code == 403


@pytest.mark.parametrize(
    "name", ["CF_ACCESS_AUD", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_EMAIL"]
)
def test_refused_when_access_is_not_configured(api, settings, name):
    setattr(settings, name, "")

    assert api.post("/login/options").status_code == 403


def test_refused_when_site_origin_is_not_configured(api, settings):
    settings.SITE_ORIGIN = ""

    assert api.post("/login/options", headers={"Origin": ""}).status_code == 403
    assert api.post("/login/options").status_code == 403


def test_admin_request_rate_is_capped(signed_in, settings):
    # Signing in took three requests: CSRF token, options and verify.
    settings.ADMIN_REQUESTS_PER_MINUTE = 4

    statuses = [signed_in.get("/session").status_code for _ in range(5)]

    assert statuses[-1] == 429
    assert 200 in statuses
