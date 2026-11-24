import hashlib
import os

os.environ["DJANGO_SECRET_KEY"] = "test-only-key-not-used-anywhere-else"
os.environ["AUDIT_CHAIN_KEY"] = "test-only-audit-key"
os.environ["DJANGO_ALLOWED_HOSTS"] = "testserver"
os.environ["SITE_ORIGIN"] = "https://portfolio.test"
os.environ["CF_ACCESS_TEAM_DOMAIN"] = "team.cloudflareaccess.test"
os.environ["CF_ACCESS_AUD"] = "test-audience-tag"
os.environ["CF_ACCESS_EMAIL"] = "owner@portfolio.test"
os.environ["BOOTSTRAP_TOKEN_SHA256"] = hashlib.sha256(b"bootstrap-token").hexdigest()
os.environ.setdefault(
    "DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/portfolio"
)
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:6379/15")
os.environ.pop("DJANGO_DEBUG", None)

from config.settings import *  # noqa: E402, F403

NOTIFIERS = ["tests.notifiers.Recorder"]

# Cloudflare's published dummy secret that always passes; the verifier is a
# local fake, so tests never call Cloudflare.
TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA"
TURNSTILE_VERIFIER = "tests.turnstile.FakeVerifier"
