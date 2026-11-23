"""Cloudflare Turnstile: the server-side check of the token a form sends.

settings.TURNSTILE_VERIFIER names a class with verify(token). The real one asks
Cloudflare. It answers True or False for a token Cloudflare could judge, and
raises Unavailable if Cloudflare could not be asked or did not answer in a form
that can be trusted, so the form fails closed: no message is accepted without a
verified token. With no secret key set it is unavailable too, so a deployment
that forgot the key does not run without the check.

Cloudflare publishes dummy keys for development and tests; the settings and
docker-compose use them (see DECISIONS, Phase 4A). The token is single use:
Cloudflare refuses one it has already verified.
"""

import json
import logging
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings

log = logging.getLogger(__name__)

SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TIMEOUT = 5
# Turnstile tokens are at most 2,048 characters.
TOKEN_MAX = 2048


class Unavailable(Exception):
    """Turnstile could not be asked, or its answer cannot be trusted."""


class CloudflareVerifier:
    def verify(self, token):
        secret = settings.TURNSTILE_SECRET_KEY
        if not secret:
            raise Unavailable("no secret key")
        request = Request(
            SITEVERIFY,
            data=urlencode({"secret": secret, "response": token}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
                body = json.loads(response.read(65_536))
        except (OSError, ValueError) as error:
            raise Unavailable(type(error).__name__) from error
        if not isinstance(body, dict) or not isinstance(body.get("success"), bool):
            raise Unavailable("unexpected answer")
        if body["success"]:
            return True
        codes = body.get("error-codes")
        # A fault on our side (a bad or missing secret, a malformed request) is
        # not the visitor failing the check.
        if isinstance(codes, list) and {
            "missing-input-secret",
            "invalid-input-secret",
            "bad-request",
            "internal-error",
        } & set(codes):
            raise Unavailable("refused by configuration")
        return False
