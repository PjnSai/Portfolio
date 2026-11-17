from django.core.management.base import BaseCommand

from core import content


class Command(BaseCommand):
    help = "Delete what has been in the trash for 30 days."

    def handle(self, *args, **options):
        counts = content.purge_trash()
        self.stdout.write(
            f"Removed {counts['sections']} sections, {counts['items']} items, "
            f"{counts['media']} images."
        )
