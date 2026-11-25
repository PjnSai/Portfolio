"""Sample content for the local dev database, so every public section, the CV
block and the admin pages have something to show.

Every word is marked SAMPLE: nothing here is a fact about the owner. Content
goes in through the same functions the admin uses (draft, then Publish), so
the admin and the public site agree. Running it again adds nothing; --reset
removes the content and puts the samples back, keeping the owner, passkeys,
sessions and the audit log.
"""

import shutil
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from core import abuse, alerts, content, cv, palettes, retention, serializers, theme
from core.models import (
    AbuseCount,
    Alert,
    BlockedSender,
    Contact,
    ContactMessage,
    ContactNote,
    CvDayCount,
    CvVersion,
    CvView,
    Media,
    Palette,
    Revision,
    Section,
    SectionItem,
    SiteSettings,
)
from devmode import config, guards
from tests.pdfs import text_pdf

PALETTE_NAME = "SAMPLE palette"


def _project(n, colour, status):
    return {
        "title": f"SAMPLE project {n}",
        "summary": f"SAMPLE summary of project {n}. Replace it in the admin.",
        "body": (
            f"SAMPLE case study for project {n}. Replace it in the admin.\n\n"
            "## SAMPLE problem\n\nSAMPLE paragraph about the problem.\n\n"
            "## SAMPLE approach\n\nSAMPLE paragraph about how it was built.\n\n"
            "## SAMPLE outcome\n\nSAMPLE paragraph about what came of it."
        ),
        "status": status,
        "created": "2025-01",
        "category": "SAMPLE category",
        "colour": colour,
        "tags": ["SAMPLE tag", f"SAMPLE tag {n}"],
        "links": [],
        "fields": [{"label": "SAMPLE what I built", "value": "SAMPLE value"}],
        "images": [],
    }


# (type, section fields, items), in page order.
SECTIONS = [
    (
        "hero",
        {
            "title": "SAMPLE intro",
            "name": "SAMPLE Name",
            "role": "SAMPLE role",
            "body": "SAMPLE intro text. Replace it in the admin.",
            "availability": "SAMPLE availability line",
        },
        [],
    ),
    (
        "about",
        {
            "title": "SAMPLE about",
            "body": "SAMPLE about text.\n\nSAMPLE second paragraph.",
            "location": "SAMPLE location",
        },
        [],
    ),
    (
        "projects",
        {"title": "SAMPLE projects", "body": ""},
        [_project(1, "blue", "live"), _project(2, "yellow", "in_progress")],
    ),
    (
        "experience",
        {"title": "SAMPLE experience", "body": ""},
        [
            {
                "organisation": "SAMPLE organisation",
                "role": "SAMPLE role",
                "start": "2024-01",
                "summary": "SAMPLE summary of the role.",
                "tags": ["SAMPLE tag"],
            }
        ],
    ),
    (
        "education",
        {"title": "SAMPLE education", "body": ""},
        [
            {
                "institution": "SAMPLE institution",
                "qualification": "SAMPLE qualification",
                "start": "2021-09",
                "end": "2024-06",
                "summary": "SAMPLE summary of the course.",
            }
        ],
    ),
    (
        "skills",
        {"title": "SAMPLE skills", "body": ""},
        [{"name": "SAMPLE group", "skills": ["SAMPLE skill one", "SAMPLE skill two"]}],
    ),
    ("contact", {"title": "SAMPLE contact", "body": "SAMPLE contact text."}, []),
    (
        "links",
        {"title": "SAMPLE links", "body": ""},
        [{"label": "SAMPLE link", "url": "https://example.com/sample"}],
    ),
]

# (name, email, reason, kind, body)
MESSAGES = [
    (
        "SAMPLE Sender One",
        "sample.one@example.com",
        "hiring",
        ContactMessage.Kind.MESSAGE,
        "SAMPLE message about a role. Nothing here is real.",
    ),
    (
        "SAMPLE Sender Two",
        "sample.two@example.com",
        "",
        ContactMessage.Kind.CV_REQUEST,
        "SAMPLE request for a copy of the CV.",
    ),
]

# (days ago, kind, count)
ABUSE = [
    (0, abuse.TURNSTILE_FAILED, 3),
    (0, abuse.RATE_LIMITED, 7),
    (1, abuse.SPAM, 2),
    (2, abuse.LOGIN_FAILED, 1),
    (3, abuse.HONEYPOT_OR_TIMING, 4),
]

ALERTS = [
    (alerts.FAILED_SIGN_INS, {"count": 5, "minutes": 15}),
    (alerts.RATE_LIMIT_STORM, {"count": 100, "minutes": 10}),
]


def require_dev_database(name):
    if not (isinstance(name, str) and name.endswith("_dev")):
        raise guards.Refused(f"  - The database {name!r} does not end in _dev.")


def _valid(shape, data):
    found = shape(data=data)
    if not found.is_valid():
        raise ValueError(f"sample content does not fit {shape.__name__}")
    return serializers.as_json(found.validated_data)


def _sections():
    if Section.objects.exists():
        return False
    for kind, fields, items in SECTIONS:
        section = content.add_section(kind, fields["title"])
        content.edit_section(section, _valid(serializers.SECTION_SHAPES[kind], fields))
        for data in items:
            content.add_item(section, _valid(content.ITEM_TYPES[kind], data))
        content.publish(section)
    return True


def _palette():
    found = content.custom_palettes().filter(name=PALETTE_NAME).first()
    if found:
        return found
    source = Palette.objects.filter(kind=Palette.Kind.PRESET).order_by(
        "-created_at", "-name"
    )[0]
    data = {"name": PALETTE_NAME, "light": source.light, "dark": source.dark}
    return palettes.add(_valid(serializers.PaletteBody, data))


def _settings(palette):
    row = content.site_settings()
    if row.published:
        return False
    draft = {
        **content.DEFAULT_SETTINGS,
        "title": "SAMPLE site title",
        "description": "SAMPLE one-line description of the site",
        "palette_mode": "pick",
        "default_palette_id": theme.DEFAULT_PALETTE,
        "enabled_palette_ids": [theme.DEFAULT_PALETTE, str(palette.id)],
    }
    content.edit_settings(row, _valid(serializers.Settings, draft))
    content.publish_settings(row)
    return True


def _cv():
    if CvVersion.objects.exists():
        return False
    data = text_pdf(pages=2, label="SAMPLE CV, placeholder")
    cv.check(data, "sample-cv.pdf", cv.CONTENT_TYPE)
    cv.set_live(cv.add(data).id)
    cv.set_switches({"view": True, "request": True, "instant_download": True})
    return True


def _inbox():
    now = timezone.now()
    added = False
    for n, (name, email, reason, kind, body) in enumerate(MESSAGES):
        if ContactMessage.objects.filter(name=name).exists():
            continue
        message = ContactMessage(
            name=name,
            email=email,
            reason=reason,
            kind=kind,
            body=body,
            created_at=now - timedelta(hours=n + 1),
        )
        retention.apply(message)
        message.save(force_insert=True)
        added = True
    return added


def _abuse_and_alerts():
    today = abuse.today()
    for days, kind, count in ABUSE:
        AbuseCount.objects.update_or_create(
            day=today - timedelta(days=days), kind=kind, defaults={"count": count}
        )
    for kind, context in ALERTS:
        summary = f"SAMPLE alert. {alerts.summary(kind, context)}"
        Alert.objects.get_or_create(kind=kind, summary=summary)


def fill():
    """Add whatever sample content is missing. Returns what was added."""
    with transaction.atomic():
        palette = _palette()
        done = {
            "sections": _sections(),
            "settings": _settings(palette),
            "cv": _cv(),
            "inbox": _inbox(),
        }
        _abuse_and_alerts()
    return done


def _remove_folder(root):
    """Only a folder inside api/.devmode, so a test or odd setting cannot
    point this anywhere else."""
    root = root.resolve()
    if root.is_relative_to(config.STATE.resolve()) and root.exists():
        shutil.rmtree(root)


def wipe():
    with transaction.atomic():
        for model in (
            SectionItem,
            Section,
            Revision,
            SiteSettings,
            Media,
            CvView,
            CvDayCount,
            CvVersion,
            ContactNote,
            ContactMessage,
            Contact,
            BlockedSender,
            AbuseCount,
            Alert,
        ):
            model.objects.all().delete()
        Palette.objects.filter(kind=Palette.Kind.CUSTOM).delete()
    _remove_folder(settings.MEDIA_ROOT)
    _remove_folder(settings.CV_ROOT)


def reset():
    wipe()
    return fill()


def run(reset=False):
    require_dev_database(connection.settings_dict["NAME"])
    if reset:
        from core import cache

        wipe()
        cache.client().flushdb()
    return fill()
