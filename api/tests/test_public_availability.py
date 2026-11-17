"""The 503 for a missing dependency belongs to the admin area only.

Public routes must keep answering when Redis is down, and the request guard
must not reach for Redis or the database on their behalf.
"""

import pytest
import redis
from django.db import OperationalError
from django.test import RequestFactory

from core.guard import GuardMiddleware

PUBLIC = ["/healthz", "/api/v1/status"]
UNAVAILABLE = {"detail": "Service unavailable."}
BROWSER = {"Origin": "https://portfolio.test", "Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def redis_down(settings):
    settings.REDIS_URL = "redis://127.0.0.1:1/0"


@pytest.mark.parametrize("path", PUBLIC)
@pytest.mark.parametrize("headers", [{}, BROWSER, {"Sec-Fetch-Site": "cross-site"}])
def test_public_routes_answer_when_redis_is_down(client, redis_down, path, headers):
    response = client.get(path, headers=headers)

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("path", PUBLIC)
def test_public_routes_answer_when_redis_is_not_configured(client, settings, path):
    settings.REDIS_URL = ""

    assert client.get(path).status_code == 200


@pytest.mark.django_db
def test_admin_is_refused_in_the_same_conditions(api, redis_down):
    response = api.post("/login/options")

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE


@pytest.mark.parametrize("path", PUBLIC)
def test_guard_uses_no_dependency_for_public_routes(client, monkeypatch, path):
    def reached(*args, **kwargs):
        raise AssertionError("the guard reached a dependency for a public route")

    monkeypatch.setattr("core.cache.client", reached)
    monkeypatch.setattr("core.access.is_valid", reached)
    monkeypatch.setattr("core.ratelimit.request_cap", reached)

    assert client.get(path).status_code == 200


@pytest.mark.parametrize(
    "error", [redis.ConnectionError("down"), OperationalError("down")]
)
def test_dependency_errors_become_503_only_under_the_admin_path(error):
    guard = GuardMiddleware(lambda request: None)
    requests = RequestFactory()

    for path in [*PUBLIC, "/api/v1/projects", "/api/v1/administrator"]:
        assert guard.process_exception(requests.get(path), error) is None
    for path in ["/api/v1/admin", "/api/v1/admin/session", "/api/v1/admin/x/y"]:
        assert guard.process_exception(requests.get(path), error).status_code == 503
