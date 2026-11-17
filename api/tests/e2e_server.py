"""Runs the API for the browser tests in web/e2e. Never used in production.

Each run starts from an empty database and a throwaway RSA key. The key stands
in for Cloudflare's: tokens are still checked in full (signature, audience,
issuer, expiry and the exact owner email), only the public key comes from here
instead of Cloudflare's key list. The token is written to E2E_TOKEN_FILE for
the browser to send, as Cloudflare Access would.
"""

import hashlib
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

ORIGIN = os.environ.get("E2E_SITE_ORIGIN", "http://localhost:3100")
PORT = os.environ.get("E2E_API_PORT", "8100")
DATABASE_URL = os.environ.get(
    "E2E_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/portfolio_e2e"
)
MEDIA_ROOT = Path(tempfile.mkdtemp(prefix="portfolio-e2e-media-"))
TOKEN_FILE = Path(os.environ.get("E2E_TOKEN_FILE", API / ".e2e-access-token"))
BOOTSTRAP_TOKEN = "e2e-bootstrap-token"
TEAM = "team.cloudflareaccess.test"
AUDIENCE = "e2e-audience"
EMAIL = "owner@portfolio.test"

os.environ.update(
    {
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "DJANGO_SECRET_KEY": "e2e-only-secret-key-not-used-anywhere-else",
        "AUDIT_CHAIN_KEY": "e2e-only-audit-key",
        "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
        "SITE_ORIGIN": ORIGIN,
        "CF_ACCESS_TEAM_DOMAIN": TEAM,
        "CF_ACCESS_AUD": AUDIENCE,
        "CF_ACCESS_EMAIL": EMAIL,
        "BOOTSTRAP_TOKEN_SHA256": hashlib.sha256(BOOTSTRAP_TOKEN.encode()).hexdigest(),
        "NOTIFIERS": "core.notify.LogNotifier",
        "DATABASE_URL": DATABASE_URL,
        "REDIS_URL": os.environ.get("E2E_REDIS_URL", "redis://127.0.0.1:6379/14"),
        "MEDIA_STORAGE": "local",
        "MEDIA_ROOT": str(MEDIA_ROOT),
        "CACHE_PURGER": "core.purge.LogPurger",
    }
)


def fresh_database():
    import psycopg
    from psycopg import sql

    parts = urlsplit(DATABASE_URL)
    name = parts.path.lstrip("/")
    if not name.endswith("_e2e"):
        raise SystemExit("E2E_DATABASE_URL must name a database ending in _e2e")
    server = urlunsplit(parts._replace(path="/postgres"))
    with psycopg.connect(server, autocommit=True) as connection:
        quoted = sql.Identifier(name)
        connection.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(quoted)
        )
        connection.execute(sql.SQL("CREATE DATABASE {}").format(quoted))


def access_token(key):
    import jwt

    now = int(time.time())
    claims = {
        "aud": [AUDIENCE],
        "iss": f"https://{TEAM}",
        "email": EMAIL,
        "iat": now,
        "exp": now + 4 * 3600,
    }
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "e2e"})


def main():
    import django
    from cryptography.hazmat.primitives.asymmetric import rsa

    fresh_database()
    django.setup()

    from django.core.management import call_command

    from core import access, cache

    call_command("migrate", verbosity=0)
    cache.client().flushdb()

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    access.fetch_signing_key = lambda token: key.public_key()
    TOKEN_FILE.write_text(access_token(key))

    call_command("runserver", f"127.0.0.1:{PORT}", use_reloader=False)


if __name__ == "__main__":
    main()
