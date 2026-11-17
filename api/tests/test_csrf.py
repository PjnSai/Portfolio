"""Every route in the API, tried with every state-changing method.

The route list is read from the URL configuration, so a new route is covered
without being added here. Three kinds of route exist:

- Session routes need the session's CSRF token.
- The four sign-in routes run before a session exists, so there is no token to
  ask for. They are listed by name below and must prove the request came from
  this site instead. Adding a fifth fails this file until it is listed.
- Public routes accept no state-changing method at all.
"""

import pytest
from django.urls import URLPattern, get_resolver

from core.authz import Level
from core.models import Session
from tests.conftest import ADMIN, ORIGIN

pytestmark = pytest.mark.django_db

ACTION_ID = "00000000-0000-4000-8000-000000000000"
UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
FORBIDDEN = {"detail": "Forbidden."}

NO_SESSION_YET = {
    f"{ADMIN}/login/options",
    f"{ADMIN}/login/verify",
    f"{ADMIN}/bootstrap/options",
    f"{ADMIN}/bootstrap/verify",
    f"{ADMIN}/recovery/options",
    f"{ADMIN}/recovery/verify",
}


def walk(patterns, prefix="/"):
    for pattern in patterns:
        path = prefix + str(pattern.pattern)
        if isinstance(pattern, URLPattern):
            yield path.replace("<uuid:action_id>", ACTION_ID), pattern.callback
        else:
            yield from walk(pattern.url_patterns, path)


ROUTES = list(walk(get_resolver().url_patterns))


def level(view):
    return getattr(view, "admin_level", None)


def cases(*levels):
    return [
        pytest.param(method, path, view, id=f"{method} {path}")
        for path, view in ROUTES
        if level(view) in levels
        for method in UNSAFE_METHODS
    ]


WITH_SESSION = cases(Level.SESSION, Level.ELEVATED)
BEFORE_SESSION = cases(Level.ACCESS)
PUBLIC = cases(None)


def send(api, method, path, **headers):
    return api.client.generic(
        method,
        path,
        "{}",
        content_type="application/json",
        secure=True,
        headers=api.headers(headers),
    )


def test_every_route_is_covered():
    assert all("<" not in path for path, _ in ROUTES)
    assert len(WITH_SESSION) + len(BEFORE_SESSION) + len(PUBLIC) == len(ROUTES) * 4
    assert len(WITH_SESSION) >= 12 * 4
    assert len(PUBLIC) >= 2 * 4


def test_only_the_sign_in_routes_run_without_a_csrf_token():
    without_token = {path for path, view in ROUTES if level(view) is Level.ACCESS}

    assert without_token == NO_SESSION_YET


@pytest.mark.parametrize("method,path,view", WITH_SESSION)
def test_rejected_without_a_valid_csrf_token(
    signed_in, new_api, passkey, method, path, view
):
    stale = signed_in.csrf
    assert signed_in.elevate(passkey).status_code == 200
    other = new_api()
    assert other.login(passkey).status_code == 200
    live = Session.objects.filter(revoked_at=None).count()
    declared = method in view.admin_methods

    for token in (None, "", "wrong-token", stale, other.csrf, signed_in.csrf + "x"):
        response = send(signed_in, method, path, **{"X-CSRF-Token": token})

        if declared:
            assert response.status_code == 403, token
            assert response.json() == FORBIDDEN
        else:
            assert response.status_code == 405, token
    assert Session.objects.filter(revoked_at=None).count() == live

    if declared:
        assert send(signed_in, method, path).status_code != 403


@pytest.mark.parametrize("method,path,view", BEFORE_SESSION)
@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": None},
        {"Origin": "https://evil.test"},
        {"Sec-Fetch-Site": None},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
    ],
)
def test_sign_in_routes_are_rejected_unless_sent_by_this_site(
    api, method, path, view, headers
):
    response = send(api, method, path, **headers)

    assert response.status_code == 403
    assert response.json() == FORBIDDEN


@pytest.mark.parametrize("method,path,view", BEFORE_SESSION)
def test_sign_in_routes_take_post_only(api, method, path, view):
    response = send(api, method, path)

    assert (response.status_code == 405) == (method != "POST")


@pytest.mark.parametrize("method,path,view", PUBLIC)
def test_public_routes_accept_no_state_changing_method(api, method, path, view):
    from_this_site = send(api, method, path)
    from_elsewhere = send(api, method, path, Origin="https://evil.test")

    assert from_this_site.status_code == 405
    assert from_elsewhere.status_code == 403
    assert ORIGIN not in from_elsewhere.content.decode()
