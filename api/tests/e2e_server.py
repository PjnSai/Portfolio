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
import uuid
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


def _item(data):
    return {"id": str(uuid.uuid4()), "data": data}


# Six more projects, so /projects has a second page (six to a page).
EXTRA_PROJECTS = [
    {
        "title": f"Seeded project {n}",
        "summary": f"Seeded project {n}.",
        "body": "",
        "status": "local",
        "colour": colour,
        "tags": ["Python"],
        "links": [],
        "fields": [],
        "images": [],
    }
    for n, colour in zip(
        range(3, 9), ["pink", "olive", "orange", "blue", "ink", "yellow"], strict=True
    )
]


# One published section of each kind the public pages render, so the browser
# tests cover the layout. Education is published empty to show its placeholder.
SEEDED = [
    (
        "hero",
        "Seeded",
        {
            "name": "Pujan Shahi",
            "role": "Software developer",
            "body": "Seeded summary for the browser tests.",
            "availability": "Seeded availability line",
        },
        [],
    ),
    ("about", "About me", {"body": "Seeded about text.", "location": "London"}, []),
    (
        "projects",
        "Selected work",
        {"body": ""},
        [
            {
                "title": "Task board",
                "summary": "Seeded project one.",
                "body": "# Problem\n\nSeeded.",
                "status": "live",
                "created": "2025-06",
                "category": "Web",
                "colour": "blue",
                "tags": ["TypeScript", "Postgres"],
                "links": [],
                "fields": [{"label": "What I built", "value": "Seeded value"}],
                "images": [],
            },
            {
                "title": "Log parser",
                "summary": "Seeded project two.",
                "body": "",
                "status": "in_progress",
                "colour": "yellow",
                "tags": ["Python"],
                "links": [],
                "fields": [],
                "images": [],
            },
            *EXTRA_PROJECTS,
        ],
    ),
    (
        "experience",
        "Work history",
        {"body": ""},
        [
            {
                "organisation": "Seeded employer",
                "role": "Seeded role",
                "start": "2024-01",
                "summary": "Seeded summary.",
                "tags": ["Django"],
            },
        ],
    ),
    ("education", "Study", {"body": ""}, []),
    (
        "skills",
        "Toolkit",
        {"body": ""},
        [
            {"name": "Languages", "skills": ["Python", "TypeScript", "SQL"]},
            {"name": "Security practice", "skills": ["Threat modelling", "OWASP ASVS"]},
        ],
    ),
    ("contact", "Contact me", {"body": "Seeded contact text."}, []),
    (
        "links",
        "Elsewhere",
        {"body": ""},
        [
            {"label": "GitHub", "url": "https://github.test/seeded"},
        ],
    ),
]
SEEDED_TITLES = [title for _, title, _, _ in SEEDED]


PICKS = [
    "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4",
    "bf7b0ec6-833c-4f4c-be66-03ce086e298a",
    "b399fb8f-5de4-462d-98f5-a81bf8046a6f",
]


def seed_published_site():
    # The site build needs published content (web/lib/site.ts) and the layout
    # tests need one section of each kind, plus the published palettes.
    from django.utils import timezone

    from core.content import DEFAULT_SETTINGS, settings_state
    from core.models import Section, SiteSettings

    now = timezone.now()
    for position, (kind, title, fields, items) in enumerate(SEEDED):
        draft = {"title": title, **fields}
        Section.objects.create(
            type=kind,
            position=position,
            draft=draft,
            published={"type": kind, **draft, "items": [_item(i) for i in items]},
            published_at=now,
        )
    # Live: visitors pick from presets A, B and E. The draft stays at the
    # defaults, which the admin tests start from.
    # The layout switcher is on so the browser tests can try all four layouts.
    live = {
        **DEFAULT_SETTINGS,
        "palette_mode": "pick",
        "enabled_palette_ids": PICKS,
        "layout_switcher": True,
    }
    row = SiteSettings.objects.create(draft=live)
    row.published = settings_state(row)
    row.published_at = now
    row.draft = dict(DEFAULT_SETTINGS)
    row.save(update_fields=["draft", "published", "published_at"])


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

    from django.conf import settings
    from django.core.management import call_command

    from core import access, cache

    # The browser suite is one client doing many sittings' work in about 30
    # seconds, near the per-minute cap of 300. The cap stays on, set higher
    # here only; tests/test_guard.py checks the cap itself.
    settings.ADMIN_REQUESTS_PER_MINUTE = 1200
    # Every page load fetches the images from the API directly, with no edge.
    settings.PUBLIC_REQUESTS_PER_MINUTE = 5000

    call_command("migrate", verbosity=0)
    cache.client().flushdb()
    seed_published_site()

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    access.fetch_signing_key = lambda token: key.public_key()
    TOKEN_FILE.write_text(access_token(key))

    call_command("runserver", f"127.0.0.1:{PORT}", use_reloader=False)


if __name__ == "__main__":
    main()
