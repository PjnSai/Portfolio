"""Clearing the Cloudflare cache after a change goes live.

settings.CACHE_PURGER names a class with purge(). In development it only logs;
in production CloudflarePurger uses a token that can purge this zone's cache
and do nothing else. The change is already saved when this runs, so a failed
purge never undoes it: the failure is kept on the settings row and in the audit
log, shown in the admin, and cleared by the next purge that works.
"""

import json
import logging
import re
from urllib.request import Request, urlopen

from django.conf import settings
from django.utils import timezone
from django.utils.module_loading import import_string

from core import audit, content
from core.models import SiteSettings

log = logging.getLogger(__name__)

ZONE = re.compile(r"[0-9a-f]{32}")
TIMEOUT = 5


class PurgeFailed(Exception):
    pass


class LogPurger:
    def purge(self):
        log.info("cache purge skipped: development purger")


class CloudflarePurger:
    def purge(self):
        zone, token = settings.CLOUDFLARE_ZONE_ID, settings.CLOUDFLARE_PURGE_TOKEN
        if not ZONE.fullmatch(zone) or not token:
            raise PurgeFailed("Cloudflare zone or token is not set")
        request = Request(
            f"https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache",
            data=json.dumps({"purge_everything": True}).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
                body = json.loads(response.read(65_536))
        except (OSError, ValueError) as error:
            raise PurgeFailed(type(error).__name__) from error
        if body.get("success") is not True:
            raise PurgeFailed("Cloudflare refused the purge")


def _row():
    return content.site_settings()


def run(reason):
    """Purge now. True if it worked; a failure is recorded, never raised."""
    try:
        import_string(settings.CACHE_PURGER)().purge()
    except Exception as error:
        log.warning("cache purge failed: %s", type(error).__name__)
        SiteSettings.objects.filter(id=_row().id).update(purge_failed_at=timezone.now())
        audit.record("cache_purge_failed", reason=reason, error=type(error).__name__)
        return False
    SiteSettings.objects.filter(id=_row().id).exclude(purge_failed_at=None).update(
        purge_failed_at=None
    )
    return True


def failed_at():
    return _row().purge_failed_at
