"""How long contact messages and the CV view log are kept (SPEC 5.8a, 6.2).

Spam goes after 30 days by default, other messages after 12 months. A message
the owner marked kept, has written notes on or linked to a contact is never
removed by the daily job; only the owner deletes it. Both periods are set by
the owner in the admin and stored on the settings row, apart from the draft and
published copies, so they never reach the public site.

expires_at on each message says when the job may remove it. It is set when the
message arrives, moved when the message changes between spam and not spam, and
all of them are moved when the owner changes a period. The spam period runs
from spam_at, so an old message marked spam today still has the full period.
"""

from datetime import UTC, datetime, timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import (
    BooleanField,
    Count,
    Exists,
    F,
    Func,
    OuterRef,
    Q,
    Subquery,
    Value,
)
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone

from core import audit, content
from core.models import (
    BlockedSender,
    ContactMessage,
    ContactNote,
    CvDayCount,
    CvView,
    Owner,
    SiteSettings,
)

MIN_DAYS = 7
MAX_DAYS = 3650
Status = ContactMessage.Status


def periods():
    """(spam days, other days). The defaults until the owner has saved settings;
    reading them never creates a settings row."""
    row = SiteSettings.objects.values_list(
        "retention_spam_days", "retention_message_days"
    ).first()
    return row or (settings.RETENTION_SPAM_DAYS, settings.RETENTION_MESSAGE_DAYS)


def apply(message):
    """Set one message's expiry from its status and the current periods. Spam
    is counted from when it became spam, anything else from when it arrived."""
    spam_days, message_days = periods()
    if message.status == Status.SPAM:
        start = message.spam_at or message.created_at
        message.expires_at = start + timedelta(days=spam_days)
    else:
        message.expires_at = message.created_at + timedelta(days=message_days)


def reapply_all():
    """After the owner changes a period, move every message's expiry."""
    spam_days, message_days = periods()
    ContactMessage.objects.filter(status=Status.SPAM).update(
        expires_at=Coalesce(F("spam_at"), F("created_at")) + timedelta(days=spam_days)
    )
    ContactMessage.objects.exclude(status=Status.SPAM).update(
        expires_at=F("created_at") + timedelta(days=message_days)
    )


# The daily job (manage.py run_retention).

# Any fixed number, the same in every run, so two runs cannot overlap.
LOCK_KEY = 4_820_190_416
BATCH_SIZE = 500


def rules(now):
    """Every rule a message must meet to be removed. They all sit in the one
    DELETE statement, so nothing can change between choosing a row and
    removing it."""
    return (
        Q(expires_at__lte=now),
        Q(kept=False),
        ~Exists(ContactNote.objects.filter(message=OuterRef("pk"))),
        Q(contact__isnull=True),
    )


class _InBatch(Func):
    """id = ANY(ARRAY(subquery)). Postgres runs an ARRAY subquery once. With
    id IN (subquery) it may run the subquery again for each row it deletes,
    and since rows already deleted are skipped, a batch could grow past its
    size."""

    template = "%(expressions)s)"
    arg_joiner = " = ANY(ARRAY"
    output_field = BooleanField()


class Busy(Exception):
    """Another run holds the lock."""


def _lock():
    """Take the job's advisory lock for this transaction, or raise Busy. Asked
    through the one owner row, which always exists, so it is a single value."""
    taken = (
        Owner.objects.annotate(
            taken=Func(
                Value(LOCK_KEY),
                function="pg_try_advisory_xact_lock",
                output_field=BooleanField(),
            )
        )
        .values_list("taken", flat=True)
        .first()
    )
    if taken is not True:
        raise Busy


def _delete_batch(now, size):
    """One DELETE statement. The inner select picks a batch, skipping any row
    another transaction holds (such as one getting a note); the outer WHERE
    checks every rule again on the row as it is when it is deleted.
    QuerySet.delete() would first select the rows to find their notes, which
    is the gap this avoids; a message with notes is never deleted, so there is
    nothing to cascade."""
    batch = (
        ContactMessage.objects.filter(*rules(now))
        .order_by("expires_at", "id")
        .select_for_update(skip_locked=True)
        .values("id")[:size]
    )
    due = ContactMessage.objects.filter(*rules(now), _InBatch(F("id"), Subquery(batch)))
    return due._raw_delete(due.db)


def _expired_blocks(now, dry_run):
    """Blocklist entries that no longer block. They are few (the list is
    capped), so one statement removes them all."""
    expired = BlockedSender.objects.filter(expires_at__lte=now)
    return expired.count() if dry_run else expired._raw_delete(expired.db)


# CV views keep their raw rows for 90 days (SPEC 5.8a (e)); then only the
# count for each day is kept. Whole UTC days only, so a day is never split
# between the rows and its total.
CV_VIEW_DAYS = 90


def cv_view_cutoff(now):
    day = (now.astimezone(UTC) - timedelta(days=CV_VIEW_DAYS)).date()
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _old_cv_views(now, dry_run):
    """Add the old rows to each day's total in cv_day_counts, then remove them
    in one DELETE. Both run under the job's lock in its transaction, so no
    other run adds to a total meanwhile, and no new row can be that old."""
    cutoff = cv_view_cutoff(now)
    old = CvView.objects.filter(at__lt=cutoff)
    if dry_run:
        return old.count()
    per_day = (
        old.annotate(day=TruncDate("at", tzinfo=UTC))
        .values("day")
        .annotate(n=Count("id"))
        .values_list("day", "n")
    )
    for day, n in per_day:
        if not CvDayCount.objects.filter(day=day).update(count=F("count") + n):
            CvDayCount.objects.create(day=day, count=n)
    return old._raw_delete(old.db)


def run(dry_run=False, batch_size=BATCH_SIZE):
    """Remove every message whose time is up and which no rule keeps, every
    blocklist entry that has expired, and CV views past their period once they
    are counted. One transaction: if anything fails, nothing is removed and
    nothing recorded. Returns counts only; the audit entry holds the same
    counts."""
    now = timezone.now()
    with transaction.atomic():
        _lock()
        deleted = batches = 0
        if dry_run:
            deleted = ContactMessage.objects.filter(*rules(now)).count()
        else:
            while True:
                removed = _delete_batch(now, batch_size)
                batches += 1
                deleted += removed
                if removed < batch_size:
                    break
        expired = ContactMessage.objects.filter(expires_at__lte=now).count()
        counts = {
            "deleted": deleted,
            "exempt": expired - (deleted if dry_run else 0),
            "batches": batches,
            "blocklist_deleted": _expired_blocks(now, dry_run),
            "cv_views_deleted": _old_cv_views(now, dry_run),
            "dry_run": dry_run,
        }
        audit.record("retention_run", **counts)
    return counts


def save(spam_days, message_days):
    """Set both periods, move every message's expiry and record it."""
    with transaction.atomic():
        row = content.site_settings()
        row.retention_spam_days = spam_days
        row.retention_message_days = message_days
        row.save(update_fields=["retention_spam_days", "retention_message_days"])
        reapply_all()
        audit.record(
            "retention_changed", spam_days=spam_days, message_days=message_days
        )
