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
from datetime import timedelta
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
CV_ROOT = Path(tempfile.mkdtemp(prefix="portfolio-e2e-cv-"))
TOKEN_FILE = Path(os.environ.get("E2E_TOKEN_FILE", API / ".e2e-access-token"))
# A signed-in session for the browser matrix, which cannot use a virtual passkey
# in every browser. The raw token is written here; only its hash is stored.
SESSION_FILE = Path(os.environ.get("E2E_SESSION_FILE", API / ".e2e-session-token"))
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
        # Cloudflare's dummy secret; the check itself is a local stand-in, so the
        # browser suite needs no network.
        "TURNSTILE_SECRET_KEY": "1x0000000000000000000000000000000AA",
        "TURNSTILE_VERIFIER": "tests.turnstile.FakeVerifier",
        "DATABASE_URL": DATABASE_URL,
        "REDIS_URL": os.environ.get("E2E_REDIS_URL", "redis://127.0.0.1:6379/14"),
        "MEDIA_STORAGE": "local",
        "MEDIA_ROOT": str(MEDIA_ROOT),
        "CV_ROOT": str(CV_ROOT),
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


# Project slugs as Publish stores them. "Seeded project 3" was first published
# under another title, so its address is not made from its title now.
RENAMED = {"Seeded project 3": "first-seeded-project"}


def _project_items(items):
    from core import slugs

    taken = set(RENAMED.values())
    found = []
    for data in items:
        slug = RENAMED.get(data["title"]) or slugs.unique(data["title"], taken)
        taken.add(slug)
        found.append({**_item(data), "slug": slug})
    return found


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
                # Deep and uneven headings, for the outline test.
                "body": (
                    "## Approach\n\nSeeded.\n\n#### Parsing\n\nSeeded.\n\n"
                    "###### Edge cases\n\nSeeded.\n\n## Outcome\n\nSeeded."
                ),
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


def seed_inbox_and_session():
    """A few messages for the inbox pages, and a session the matrix can use."""
    import hashlib
    import secrets

    from django.utils import timezone

    from core import retention
    from core.models import ContactMessage, ContactNote, Owner, Session

    now = timezone.now()
    rows = [
        (
            "Matrix Sender One",
            "one@matrix.example",
            "hiring",
            "new",
            0,
            "A short message about a role.",
        ),
        (
            "Matrix Sender Two With A Very Long Name That Keeps Going",
            "a.very.long.address.that.keeps.going.and.going@a-long-domain-name.example",
            "project",
            "read",
            0,
            "A message with an unbroken word: "
            + "x" * 90
            + chr(10) * 2
            + "And a second paragraph to show line breaks.",
        ),
        (
            "Matrix Sender Three",
            "three@matrix.example",
            "",
            "replied",
            20,
            "See https://one.example for details.",
        ),
        (
            "Matrix Held Back",
            "held@matrix.example",
            "other",
            "spam",
            100,
            "Cheap watches, buy now.",
        ),
    ]
    for n, (name, email, reason, status, score, body) in enumerate(rows):
        message = ContactMessage(
            name=name,
            email=email,
            reason=reason,
            status=status,
            spam_score=score,
            body=body,
            created_at=now - timedelta(minutes=10 - n),
        )
        retention.apply(message)
        message.save(force_insert=True)
        if status == "replied":
            ContactNote.objects.create(
                message=message, text="Sent the CV.", kind="responded_with_details"
            )
    seed_contacts_and_blocks(now)
    token = secrets.token_urlsafe(32)
    Session.objects.create(
        owner=Owner.objects.get(),
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
    )
    SESSION_FILE.write_text(token)


def seed_contacts_and_blocks(now):
    """Two saved contacts (one with long values, its follow-up due) linked to
    seeded messages, and two blocklist entries (one with a kept address and a
    long note), so the matrix has something to look at on those pages."""
    from datetime import date

    from core import contact as contact_hash
    from core.models import BlockedSender, Contact, ContactMessage

    long_email = (
        "a.very.long.address.that.keeps.going.and.going@a-long-domain-name.example"
    )
    people = [
        (
            "Matrix Sender Two With A Very Long Name That Keeps Going",
            long_email,
            "Organisation " + "y" * 80,
            ["recruiter", "a-very-long-tag-name-that-keeps-going"],
            "Notes with an unbroken word: " + "z" * 120,
            date(2026, 1, 1),
        ),
        (
            "Matrix Sender Three",
            "three@matrix.example",
            "Halverton Recruitment",
            ["spring"],
            "Met at the careers fair.",
            None,
        ),
    ]
    for name, email, organisation, tags, notes, follow_up in people:
        found = Contact.objects.create(
            name=name,
            email=email,
            organisation=organisation,
            tags=tags,
            notes=notes,
            follow_up=follow_up,
        )
        ContactMessage.objects.filter(email_hash=contact_hash.email_hash(email)).update(
            contact=found
        )
    kept = "long.blocked.address.that.keeps.going@a-long-domain-name.example"
    for email, keep, note, hits in [
        ("hash.only@matrix.example", None, "Kept sending offers", 4),
        (kept, kept, "n" * 190, 0),
    ]:
        BlockedSender.objects.create(
            email_hash=contact_hash.email_hash(email),
            email=keep,
            note=note,
            created_at=now - timedelta(days=30),
            expires_at=now + timedelta(days=335),
            hit_count=hits,
            last_hit_at=now - timedelta(days=2) if hits else None,
        )


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
            published={
                "type": kind,
                **draft,
                "items": _project_items(items)
                if kind == "projects"
                else [_item(i) for i in items],
            },
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


def seed_abuse_and_alerts():
    """Abuse counts on days before today (the browser tests add to today's
    row, so the seeded days stay exact), and alerts: one unseen, one seen and
    22 older seen ones so the alerts page has a second page."""
    from datetime import timedelta

    from django.utils import timezone

    from core import abuse
    from core.models import AbuseCount, Alert

    today = abuse.today()
    for days_ago, kind, count in [
        (3, abuse.SPAM, 2),
        (3, abuse.TURNSTILE_FAILED, 4),
        (5, abuse.SPAM, 1),
        (40, abuse.RATE_LIMITED, 6),
    ]:
        AbuseCount.objects.create(
            day=today - timedelta(days=days_ago), kind=kind, count=count
        )
    now = timezone.now()
    Alert.objects.create(
        created_at=now - timedelta(hours=2),
        kind="rate_limit_storm",
        summary="100 requests refused by a rate limit in 10 minutes.",
    )
    Alert.objects.create(
        created_at=now - timedelta(days=1),
        kind="failed_sign_ins",
        summary="5 failed sign-ins or passkey confirmations in 15 minutes.",
        seen_at=now - timedelta(hours=20),
    )
    for n in range(22):
        Alert.objects.create(
            created_at=now - timedelta(days=2, minutes=n),
            kind="error_spike",
            summary=f"20 server errors in 5 minutes (older alert {n + 1}).",
            seen_at=now - timedelta(days=1),
        )


def seed_cv():
    """One live CV, so the public viewer, request and download have a file."""
    from core import cv
    from tests.pdfs import text_pdf

    cv.set_live(cv.add(text_pdf()).id)


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
    seed_inbox_and_session()
    seed_cv()
    seed_abuse_and_alerts()

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    access.fetch_signing_key = lambda token: key.public_key()
    TOKEN_FILE.write_text(access_token(key))

    call_command("runserver", f"127.0.0.1:{PORT}", use_reloader=False)


if __name__ == "__main__":
    main()
