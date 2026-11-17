"""Cloudflare Access: every admin request must carry a token Cloudflare signed."""

import hmac
from functools import lru_cache

import jwt
from django.conf import settings

HEADER = "Cf-Access-Jwt-Assertion"


@lru_cache(maxsize=2)
def _jwks(url):
    return jwt.PyJWKClient(url, timeout=3)


def fetch_signing_key(token):
    """Public key Cloudflare Access signed this token with, from the team's JWKS."""
    url = f"https://{settings.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs"
    return _jwks(url).get_signing_key_from_jwt(token).key


def is_valid(token):
    """True only for an unexpired RS256 token for this app and this owner.

    Anything else is a refusal: missing settings, unreachable keys, a bad
    signature, the wrong audience, issuer or email.
    """
    audience = settings.CF_ACCESS_AUD
    team = settings.CF_ACCESS_TEAM_DOMAIN
    owner = settings.CF_ACCESS_EMAIL
    if not (token and audience and team and owner):
        return False
    try:
        claims = jwt.decode(
            token,
            fetch_signing_key(token),
            algorithms=["RS256"],
            audience=audience,
            issuer=f"https://{team}",
            options={"require": ["exp", "iat", "aud", "iss"]},
        )
    except Exception:
        return False
    # Compared exactly: no case folding or trimming, so only the address the
    # Access policy names gets through.
    email = claims.get("email")
    return isinstance(email, str) and hmac.compare_digest(
        email.encode("utf-8", "replace"), owner.encode("utf-8", "replace")
    )
