import re
import time
from datetime import timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.test import Client

from tests.authenticator import SoftAuthenticator
from tests.notifiers import Recorder

ORIGIN = "https://portfolio.test"
ADMIN = "/api/v1/admin"
COOKIE = "__Host-session"
CSRF_COOKIE = "__Host-csrf"
PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000"
PLACEHOLDER_FILE = "00000000000000000000000000000000-480.webp"


@pytest.fixture(scope="session")
def access_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def access_token(key, **overrides):
    now = int(time.time())
    claims = {
        "aud": [settings.CF_ACCESS_AUD],
        "iss": f"https://{settings.CF_ACCESS_TEAM_DOMAIN}",
        "email": settings.CF_ACCESS_EMAIL,
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})


@pytest.fixture(autouse=True)
def access(monkeypatch, access_key):
    monkeypatch.setattr(
        "core.access.fetch_signing_key", lambda token: access_key.public_key()
    )
    return lambda **overrides: access_token(access_key, **overrides)


@pytest.fixture(autouse=True)
def clean_state():
    from core import cache

    cache.client().flushdb()
    Recorder.sent.clear()


class Api:
    """Test client that sends what the owner's browser would send."""

    def __init__(self, token):
        self.client = Client(enforce_csrf_checks=True)
        self.access_token = token
        self.csrf = None

    def fetch_csrf(self):
        """Get a CSRF token and its cookie, as the admin page does on load."""
        response = self.client.get(ADMIN + "/csrf", secure=True, headers=self.headers())
        if response.status_code == 200:
            self.csrf = response.json()["csrf_token"]
        return response

    def headers(self, overrides=None):
        headers = {
            "Cf-Access-Jwt-Assertion": self.access_token,
            "Origin": ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "X-CSRF-Token": self.csrf,
        }
        headers.update(overrides or {})
        return {k: v for k, v in headers.items() if v is not None}

    def get(self, path, params=None, headers=None):
        return self.client.get(
            ADMIN + path, params, secure=True, headers=self.headers(headers)
        )

    def post(self, path, body=None, headers=None):
        if self.csrf is None:
            self.fetch_csrf()
        return self.client.post(
            ADMIN + path,
            body or {},
            content_type="application/json",
            secure=True,
            headers=self.headers(headers),
        )

    def patch(self, path, body=None, headers=None):
        if self.csrf is None:
            self.fetch_csrf()
        return self.client.patch(
            ADMIN + path,
            body or {},
            content_type="application/json",
            secure=True,
            headers=self.headers(headers),
        )

    def request(self, method, path, headers=None):
        send = {"GET": self.get, "PATCH": self.patch}.get(method, self.post)
        return send(path, headers=headers)

    @property
    def cookie(self):
        morsel = self.client.cookies.get(COOKIE)
        return morsel.value if morsel else None

    def set_cookie(self, value):
        self.client.cookies[COOKIE] = value

    def login(self, authenticator, **tamper):
        options = self.post("/login/options")
        if options.status_code != 200:
            return options
        response = self.post(
            "/login/verify",
            {"credential": authenticator.get(options.json(), **tamper)},
        )
        if response.status_code == 200:
            self.csrf = response.json()["csrf_token"]
        return response

    def elevate(self, authenticator, **tamper):
        options = self.post("/elevate/options")
        if options.status_code != 200:
            return options
        response = self.post(
            "/elevate/verify",
            {"credential": authenticator.get(options.json(), **tamper)},
        )
        if response.status_code == 200:
            self.csrf = response.json()["csrf_token"]
        return response


@pytest.fixture
def new_api(access):
    return lambda: Api(access())


@pytest.fixture
def api(new_api):
    return new_api()


@pytest.fixture
def passkey(db):
    from core.models import AdminCredential

    authenticator = SoftAuthenticator()
    AdminCredential.objects.create(
        credential_id=authenticator.credential_id,
        public_key=authenticator.cose_key,
        name="Test key",
    )
    return authenticator


@pytest.fixture
def signed_in(api, passkey):
    assert api.login(passkey).status_code == 200
    return api


@pytest.fixture
def elevated(signed_in, passkey):
    assert signed_in.elevate(passkey).status_code == 200
    return signed_in


def age_sessions(**delta):
    """Move every session back in time, as if the clock had advanced."""
    from core.models import Session

    shift = timedelta(**delta)
    for session in Session.objects.all():
        session.created_at -= shift
        session.authenticated_at -= shift
        session.last_seen_at -= shift
        if session.elevated_until:
            session.elevated_until -= shift
        session.save()


def fill_path(path):
    """A route pattern with every converter replaced by a well-formed value."""
    path = re.sub(r"<uuid:\w+>", PLACEHOLDER_ID, path)
    path = re.sub(r"<str:\w+>", PLACEHOLDER_FILE, path)
    return re.sub(r"<int:\w+>", "1", path)


def mature(action, **past):
    """Make a pending action look as if it was requested that long ago."""
    shift = timedelta(**past)
    action.requested_at -= shift
    action.execute_after -= shift
    action.expires_at -= shift
    action.save()


def new_message(**fields):
    """A contact message as the form would store it."""
    from django.utils import timezone

    from core.models import ContactMessage

    values = {
        "name": "A",
        "email": "a@example.com",
        "body": "Hello there, a message.",
        "expires_at": timezone.now() + timedelta(days=365),
    }
    values.update(fields)
    return ContactMessage.objects.create(**values)
