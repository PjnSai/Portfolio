"""Fixed values for the local development mode. None of them is a secret:
they only work on this computer, against a database whose name ends in _dev."""

from pathlib import Path

API = Path(__file__).resolve().parent.parent
STATE = API / ".devmode"
BOOTSTRAP_FILE = STATE / "bootstrap-token"

API_HOST = "127.0.0.1"
API_PORT = 8000
WEB_ORIGIN = "http://localhost:3000"

# The test containers (docs/HANDOFF.md): Postgres on 55432, Redis on 6379.
# Redis database 13 is the dev one; the tests use 15 and the browser tests 14.
DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:55432/portfolio_dev"
REDIS_URL = "redis://127.0.0.1:6379/13"

# The .invalid top-level name never resolves, so the real key lookup cannot
# find keys for this team anywhere.
TEAM = "dev.cloudflareaccess.invalid"
AUDIENCE = "portfolio-local-dev"
EMAIL = "owner@local-dev.invalid"

# Cloudflare's published Turnstile test keys: the secret always passes.
TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA"
TURNSTILE_SITE_KEY = "1x00000000000000000000AA"


def environment(database_url, redis_url, bootstrap_sha256):
    """The whole environment the API gets in the launcher process."""
    return {
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "DJANGO_DEBUG": "1",
        "DJANGO_SECRET_KEY": "local-dev-only-secret-key-not-used-anywhere-else",
        "AUDIT_CHAIN_KEY": "local-dev-only-audit-key",
        "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
        "SITE_ORIGIN": WEB_ORIGIN,
        "CF_ACCESS_TEAM_DOMAIN": TEAM,
        "CF_ACCESS_AUD": AUDIENCE,
        "CF_ACCESS_EMAIL": EMAIL,
        "BOOTSTRAP_TOKEN_SHA256": bootstrap_sha256,
        "NOTIFIERS": "core.notify.LogNotifier",
        "TURNSTILE_SECRET_KEY": TURNSTILE_SECRET_KEY,
        "DATABASE_URL": database_url,
        "REDIS_URL": redis_url,
        "MEDIA_STORAGE": "local",
        "MEDIA_ROOT": str(STATE / "media"),
        "CV_ROOT": str(STATE / "cv"),
        "CACHE_PURGER": "core.purge.LogPurger",
        "SITE_DEPLOYER": "core.deploy.LogDeployer",
    }
