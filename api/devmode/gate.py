"""Stands in for Cloudflare Access in the launcher process only.

core.access is not changed: it still checks every token in full (signature,
audience, issuer, expiry, exact email). Here the key it checks against is a
throwaway one made at start and held in memory, and every request from this
computer is given a fresh token signed with it, as Cloudflare would add one.
"""

import time

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from core import access

HEADER_KEY = "HTTP_" + access.HEADER.upper().replace("-", "_")
LIFETIME = 60
KEY_ID = "local-dev"
LOOPBACK = ("127.0.0.1", "::1")


def new_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(key, *, team, audience, email):
    now = int(time.time())
    claims = {
        "aud": [audience],
        "iss": f"https://{team}",
        "email": email,
        "iat": now,
        "exp": now + LIFETIME,
    }
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": KEY_ID})


def install(key):
    """Point the key lookup at the throwaway key, in this process only."""
    public = key.public_key()
    access.fetch_signing_key = lambda token: public


class Gate:
    def __init__(self, app, key, *, team, audience, email):
        self.app = app
        self.key = key
        self.claims = {"team": team, "audience": audience, "email": email}

    def __call__(self, environ, start_response):
        # A header the client sent is never passed on.
        environ.pop(HEADER_KEY, None)
        if environ.get("REMOTE_ADDR") in LOOPBACK:
            environ[HEADER_KEY] = token(self.key, **self.claims)
        return self.app(environ, start_response)
