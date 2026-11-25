import argparse
import logging

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError

from core import retention

log = logging.getLogger(__name__)
BATCH_MAX = 10_000


def batch_size(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("a whole number") from None
    if not 1 <= value <= BATCH_MAX:
        raise argparse.ArgumentTypeError(f"from 1 to {BATCH_MAX}")
    return value


class Command(BaseCommand):
    help = (
        "Delete contact messages whose retention period has ended, and count "
        "then remove old CV views (run daily)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Count what would be deleted; delete nothing.",
        )
        parser.add_argument(
            "--batch-size",
            type=batch_size,
            default=retention.BATCH_SIZE,
            help="Messages deleted per statement.",
        )

    def handle(self, *args, dry_run=False, batch_size=retention.BATCH_SIZE, **opts):
        try:
            counts = retention.run(dry_run=dry_run, batch_size=batch_size)
        except retention.Busy:
            log.error("retention outcome=busy")
            raise CommandError(
                "Another run is in progress. Nothing was deleted."
            ) from None
        except DatabaseError as error:
            log.error("retention outcome=database_error %s", type(error).__name__)
            raise CommandError("Database error. Nothing was deleted.") from None
        log.info(
            "retention outcome=done deleted=%d exempt=%d batches=%d "
            "blocklist_deleted=%d cv_views_deleted=%d dry_run=%s",
            counts["deleted"],
            counts["exempt"],
            counts["batches"],
            counts["blocklist_deleted"],
            counts["cv_views_deleted"],
            counts["dry_run"],
        )
        verb = "Would delete" if dry_run else "Deleted"
        self.stdout.write(
            f"{verb} {counts['deleted']} messages; "
            f"{counts['exempt']} past their date are kept by a rule; "
            f"{counts['blocklist_deleted']} expired blocklist entries; "
            f"{counts['cv_views_deleted']} CV views past "
            f"{retention.CV_VIEW_DAYS} days counted and removed."
        )
