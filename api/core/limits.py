"""Contact form limits the owner can change, and the fixed limits shown beside
them.

Each editable limit is stored on the settings row, apart from the draft and
published copies, so it never reaches the public site. A limit the owner has
not set is the default from settings.py. The form reads the values in force at
the time of each submission.
"""

from typing import NamedTuple

from django.conf import settings
from django.db import transaction

from core import audit
from core.models import SiteSettings


class Limit(NamedTuple):
    field: str
    default: str
    low: int
    high: int


EDITABLE = {
    "human_daily_cap": Limit("contact_human_daily_cap", "CONTACT_DAILY_CAP", 1, 200),
    "spam_daily_cap": Limit("contact_spam_daily_cap", "CONTACT_SPAM_DAILY_CAP", 0, 200),
    "per_address_per_hour": Limit(
        "contact_per_address_per_hour", "CONTACT_PER_ADDRESS_PER_HOUR", 1, 50
    ),
    "per_email_per_day": Limit(
        "contact_per_email_per_day", "CONTACT_PER_EMAIL_PER_DAY", 1, 20
    ),
    "min_seconds": Limit("contact_min_seconds", "CONTACT_MIN_SECONDS", 0, 30),
    "max_links": Limit("contact_max_links", "CONTACT_MAX_LINKS", 0, 10),
    "spam_threshold": Limit(
        "contact_spam_threshold", "CONTACT_SPAM_THRESHOLD", 50, 100
    ),
    # Applies to entries added or renewed after a change; others keep their date.
    "blocklist_months": Limit("blocklist_months", "BLOCKLIST_MONTHS", 1, 36),
}
FIELDS = [limit.field for limit in EDITABLE.values()]


def defaults():
    return {name: getattr(settings, limit.default) for name, limit in EDITABLE.items()}


def _from_row(row):
    base = defaults()
    if row is None:
        return base
    stored = dict(zip(EDITABLE, row, strict=True))
    return {name: base[name] if v is None else v for name, v in stored.items()}


def effective():
    """The values in force now. Reading them never creates the settings row."""
    return _from_row(SiteSettings.objects.values_list(*FIELDS).first())


def save(changes):
    """Set the given limits and record which changed, old and new numbers
    only. Nothing changed means no audit entry."""
    from core import content

    with transaction.atomic():
        row = content.site_settings()
        row = SiteSettings.objects.select_for_update().get(id=row.id)
        before = _from_row([getattr(row, field) for field in FIELDS])
        for name, value in changes.items():
            setattr(row, EDITABLE[name].field, value)
        row.save(update_fields=[EDITABLE[name].field for name in changes])
        changed = {
            name: {"old": before[name], "new": value}
            for name, value in changes.items()
            if before[name] != value
        }
        if changed:
            audit.record("limits_changed", changes=changed)


def fixed():
    """Limits set in code, read where they are defined so the list cannot drift
    from what is enforced. Shown to the owner, not editable."""
    from core import blocklist, ratelimit, sessions, vital

    def minutes(delta):
        return int(delta.total_seconds() // 60)

    rows = [
        ("public_requests_per_minute", settings.PUBLIC_REQUESTS_PER_MINUTE, "count"),
        ("admin_requests_per_minute", settings.ADMIN_REQUESTS_PER_MINUTE, "count"),
        ("sign_in_failures_per_client", settings.LOGIN_MAX_FAILURES, "count"),
        ("sign_in_failures_overall", settings.LOGIN_GLOBAL_MAX_FAILURES, "count"),
        ("sign_in_failure_window", ratelimit.FAILURE_WINDOW // 60, "minutes"),
        ("sign_in_lockout", minutes(ratelimit.COOL_DOWN), "minutes"),
        ("session_idle_timeout", minutes(sessions.IDLE), "minutes"),
        ("session_absolute_timeout", minutes(sessions.ABSOLUTE), "minutes"),
        ("passkey_confirmation_lasts", minutes(sessions.ELEVATION), "minutes"),
        ("vital_action_wait", minutes(vital.DELAY), "minutes"),
        ("blocklist_max_entries", blocklist.MAX_ENTRIES, "count"),
    ]
    return [{"name": name, "value": value, "unit": unit} for name, value, unit in rows]


def describe():
    values, base = effective(), defaults()
    return {
        "editable": {
            name: {
                "value": values[name],
                "default": base[name],
                "min": limit.low,
                "max": limit.high,
            }
            for name, limit in EDITABLE.items()
        },
        "fixed": fixed(),
    }
