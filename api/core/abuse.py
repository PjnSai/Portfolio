"""Abuse counters (SPEC 5.13): how many refusals and flags of each kind there
were on each UTC day, so the owner can see abuse and tune the limits.

Counts only. Nothing here takes or keeps an address, an email, a message or a
key of any kind, only the kind and the day.

Counting is best effort. count() never raises: if the database cannot take
the count, it is logged and the request carries on with the answer it would
have had anyway. The check that refused the request is not changed by it.
"""

import logging
from datetime import UTC, timedelta

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from core.models import AbuseCount

log = logging.getLogger(__name__)

RATE_LIMITED = "rate_limited"
BLOCKED_SENDER = "blocked_sender"
TURNSTILE_FAILED = "turnstile_failed"
REJECTED_FORM = "rejected_form"
SPAM = "spam"
HONEYPOT_OR_TIMING = "honeypot_or_timing"
LOGIN_FAILED = "login_failed"
ELEVATION_FAILED = "elevation_failed"
GUARD_REFUSED = "guard_refused"

KINDS = (
    RATE_LIMITED,
    BLOCKED_SENDER,
    TURNSTILE_FAILED,
    REJECTED_FORM,
    SPAM,
    HONEYPOT_OR_TIMING,
    LOGIN_FAILED,
    ELEVATION_FAILED,
    GUARD_REFUSED,
)

# The counts are kept as long as a contact message (SPEC 6.2: 12 months), then
# removed by the daily job (core.retention).
KEEP_DAYS = 365
DEFAULT_DAYS = 30
MAX_DAYS = 366


def today():
    return timezone.now().astimezone(UTC).date()


def count(kind):
    """Add one to today's count for this kind. Never raises."""
    if kind not in KINDS:
        log.error("abuse count skipped: unknown kind")
        return
    try:
        with transaction.atomic():
            _add(kind, today())
    except Exception as error:
        log.warning("abuse count failed kind=%s error=%s", kind, type(error).__name__)


def kind_of_spam(outcome):
    """The kind a contact spam outcome (core.contact.spam_score) counts as."""
    if outcome in ("spam_honeypot", "spam_timing"):
        return HONEYPOT_OR_TIMING
    return SPAM


def refused(kind, response):
    """Count the refusal and hand the response back unchanged."""
    count(kind)
    return response


def _add(kind, day):
    # One UPDATE adds the one, so two requests can never lose a count. The
    # first count of a day finds no row: the day's rows are made at zero, any
    # already there are left alone, and the same UPDATE runs again.
    rows = AbuseCount.objects.filter(day=day, kind=kind)
    if rows.update(count=F("count") + 1):
        return
    AbuseCount.objects.bulk_create(
        [AbuseCount(day=day, kind=name) for name in KINDS], ignore_conflicts=True
    )
    rows.update(count=F("count") + 1)


def summary(start, end, kinds=KINDS):
    """Totals for each kind and the count for each day from start to end, both
    included, with zero for a day or kind that had none."""
    found = AbuseCount.objects.filter(
        day__gte=start, day__lte=end, kind__in=kinds
    ).values_list("day", "kind", "count")
    by_day = {}
    for day, kind, n in found:
        by_day.setdefault(day, {})[kind] = n
    days = []
    totals = dict.fromkeys(kinds, 0)
    day = start
    while day <= end:
        counts = {kind: by_day.get(day, {}).get(kind, 0) for kind in kinds}
        for kind, n in counts.items():
            totals[kind] += n
        days.append({"day": day.isoformat(), "counts": counts})
        day += timedelta(days=1)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "kinds": list(kinds),
        "totals": totals,
        "days": days,
    }


def cutoff(now):
    """Days before this one are removed by the daily job."""
    return now.astimezone(UTC).date() - timedelta(days=KEEP_DAYS)
