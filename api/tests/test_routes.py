"""Every admin route, tried with no, expired, wrong and correct sessions."""

import secrets

import pytest
from django.urls import get_resolver
from django.utils import timezone

from core import admin_urls
from core.authz import Level, admin_route
from core.models import Session
from tests.conftest import age_sessions, fill_path

pytestmark = pytest.mark.django_db

NOT_SIGNED_IN = {"detail": "Not signed in."}


def routes(*levels):
    found = []
    for pattern in admin_urls.urlpatterns:
        path = fill_path("/" + str(pattern.pattern))
        route_level = getattr(pattern.callback, "admin_level", None)
        by_method = getattr(pattern.callback, "admin_levels", {})
        for method in getattr(pattern.callback, "admin_methods", ["GET"]):
            level = by_method.get(method, route_level)
            if not levels or level in levels:
                found.append(pytest.param(method, path, level, id=f"{method} {path}"))
    return found


ALL = routes()
NEED_SESSION = routes(Level.SESSION, Level.ELEVATED)
SESSION_ONLY = routes(Level.SESSION)
NEED_ELEVATION = routes(Level.ELEVATED)
PRE_SESSION = routes(Level.ACCESS)
UNSAFE = [route for route in NEED_SESSION if route.values[0] != "GET"]


def test_route_table_is_not_empty():
    assert len(SESSION_ONLY) >= 5
    assert len(NEED_ELEVATION) >= 3
    assert len(PRE_SESSION) >= 2


def test_every_url_under_admin_goes_through_the_central_check():
    resolver = get_resolver()
    admin = [p for p in resolver.url_patterns if str(p.pattern) == "api/v1/admin/"]

    assert len(admin) == 1
    assert admin[0].urlconf_module is admin_urls
    for pattern in admin_urls.urlpatterns:
        assert isinstance(pattern.callback.admin_level, Level), str(pattern.pattern)


@pytest.mark.parametrize("method,path,level", ALL)
def test_without_access_token(signed_in, method, path, level):
    response = signed_in.request(
        method, path, headers={"Cf-Access-Jwt-Assertion": None}
    )

    assert response.status_code == 403


@pytest.mark.parametrize("method,path,level", NEED_SESSION)
def test_without_session(api, passkey, method, path, level):
    response = api.request(method, path)

    assert response.status_code == 401
    assert response.json() == NOT_SIGNED_IN


@pytest.mark.parametrize("method,path,level", NEED_SESSION)
def test_with_wrong_session(signed_in, method, path, level):
    signed_in.set_cookie(secrets.token_urlsafe(32))

    response = signed_in.request(method, path)

    assert response.status_code == 401
    assert response.json() == NOT_SIGNED_IN


@pytest.mark.parametrize("method,path,level", NEED_SESSION)
@pytest.mark.parametrize("age", [{"minutes": 16}, {"hours": 9}])
def test_with_expired_session(elevated, method, path, level, age):
    age_sessions(**age)

    response = elevated.request(method, path)

    assert response.status_code == 401
    assert response.json() == NOT_SIGNED_IN


@pytest.mark.parametrize("method,path,level", NEED_SESSION)
def test_with_revoked_session(elevated, method, path, level):
    Session.objects.update(revoked_at=timezone.now())

    response = elevated.request(method, path)

    assert response.status_code == 401
    assert response.json() == NOT_SIGNED_IN


@pytest.mark.parametrize("method,path,level", SESSION_ONLY)
def test_with_correct_session(signed_in, method, path, level):
    response = signed_in.request(method, path)

    assert response.status_code not in (401, 403, 500)


@pytest.mark.parametrize("method,path,level", NEED_ELEVATION)
def test_vital_route_needs_passkey_confirmation(signed_in, method, path, level):
    response = signed_in.request(method, path)

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"


@pytest.mark.parametrize("method,path,level", NEED_ELEVATION)
def test_vital_route_with_confirmation(elevated, method, path, level):
    response = elevated.request(method, path)

    assert response.status_code not in (401, 403, 500)


@pytest.mark.parametrize("method,path,level", NEED_ELEVATION)
def test_confirmation_lasts_minutes(elevated, method, path, level):
    age_sessions(minutes=6)

    response = elevated.request(method, path)

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"


@pytest.mark.parametrize("method,path,level", UNSAFE)
@pytest.mark.parametrize("token", [None, "", "wrong-token"])
def test_state_change_without_csrf_token(elevated, method, path, level, token):
    response = elevated.request(method, path, headers={"X-CSRF-Token": token})

    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden."}


@pytest.mark.parametrize("method,path,level", UNSAFE)
def test_csrf_token_from_another_session_is_refused(
    elevated, new_api, passkey, method, path, level
):
    other = new_api()
    other.login(passkey)

    response = elevated.request(method, path, headers={"X-CSRF-Token": other.csrf})

    assert response.status_code == 403


@pytest.mark.parametrize("method,path,level", PRE_SESSION)
def test_sign_in_routes_work_without_a_session(api, method, path, level):
    response = api.request(method, path)

    assert response.status_code in (200, 400, 401)


@pytest.mark.parametrize("method,path,level", ALL)
def test_wrong_method_does_not_bypass_the_check(api, method, path, level):
    other = api.get if method == "POST" else api.post
    response = other(path, headers={"Cf-Access-Jwt-Assertion": None})

    assert response.status_code == 403


def test_a_route_lists_where_it_needs_elevation():
    view = dict((str(p.pattern), p.callback) for p in admin_urls.urlpatterns)
    assert view["retention"].admin_levels == {
        "GET": Level.SESSION,
        "PATCH": Level.ELEVATED,
    }


@pytest.mark.parametrize(
    "level,methods,elevate",
    [
        (Level.SESSION, ("GET",), ("PATCH",)),
        (Level.ACCESS, ("GET", "PATCH"), ("PATCH",)),
    ],
)
def test_elevate_only_names_methods_of_a_session_route(level, methods, elevate):
    with pytest.raises(ValueError):
        admin_route(level, methods=methods, elevate=elevate)
