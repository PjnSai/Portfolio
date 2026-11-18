"""Rebuilding the static site on Cloudflare Pages after a change goes live.

The public pages are built from GET /api/v1/site, so a change reaches visitors
only after a new build. settings.SITE_DEPLOYER names a class with deploy(): in
development it only logs; PagesDeployer calls the project's deploy hook.

The hook URL is a credential: anyone holding it can start builds. It is read
from the environment, refused unless it points at Cloudflare's deploy hook
path, and never logged, stored, audited or returned.

At most one call per WINDOW. A change inside the window is kept as pending
and goes out with the next change after it, or with "Deploy now" in the admin.
"""

import json
import logging
import math
import re
from datetime import timedelta
from urllib.request import Request, urlopen

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from core import audit, content, purge
from core.models import SiteSettings

log = logging.getLogger(__name__)

WINDOW = timedelta(minutes=2)
TIMEOUT = 5
HOOK = re.compile(
    r"https://api\.cloudflare\.com/client/v4/pages/webhooks/deploy_hooks/"
    r"[A-Za-z0-9-]{1,100}"
)


class DeployFailed(Exception):
    pass


class LogDeployer:
    def deploy(self):
        log.info("site deploy skipped: development deployer")


class PagesDeployer:
    def deploy(self):
        url = settings.PAGES_DEPLOY_HOOK_URL
        if not HOOK.fullmatch(url):
            raise DeployFailed("deploy hook is not set or not a Pages hook")
        # The pattern above allows https to api.cloudflare.com only.
        request = Request(url, data=b"", method="POST")  # noqa: S310
        try:
            with urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
                body = json.loads(response.read(65_536))
        except (OSError, ValueError) as error:
            # Only the type: an error message could quote the URL.
            raise DeployFailed(type(error).__name__) from None
        if not isinstance(body, dict) or body.get("success") is not True:
            raise DeployFailed("Cloudflare refused the deploy")


def _when(value):
    return value.isoformat() if value else None


def status(row=None):
    row = row or content.site_settings()
    left = 0
    if row.deploy_pending and row.deploy_called_at:
        left = (row.deploy_called_at + WINDOW - timezone.now()).total_seconds()
    return {
        "called_at": _when(row.deploy_called_at),
        "result": row.deploy_result or None,
        "pending": row.deploy_pending,
        # Seconds until "Deploy now" will call the hook; 0 means now.
        "retry_after": max(0, math.ceil(left)),
    }


def request(reason):
    """Ask for a rebuild now, or mark one pending. Never raises."""
    row_id = content.site_settings().id
    now = timezone.now()
    with transaction.atomic():
        row = SiteSettings.objects.select_for_update().get(id=row_id)
        if row.deploy_called_at and now - row.deploy_called_at < WINDOW:
            row.deploy_pending = True
            row.save(update_fields=["deploy_pending"])
            audit.record("site_deploy_debounced", reason=reason)
            return status(row)
        row.deploy_called_at = now
        row.deploy_pending = False
        row.save(update_fields=["deploy_called_at", "deploy_pending"])

    detail = {"reason": reason, "result": "ok"}
    try:
        import_string(settings.SITE_DEPLOYER)().deploy()
    except Exception as error:
        log.warning("site deploy failed: %s", type(error).__name__)
        detail.update(result="failed", error=type(error).__name__)
    SiteSettings.objects.filter(id=row_id).update(deploy_result=detail["result"])
    audit.record("site_deploy_requested", **detail)
    return status(SiteSettings.objects.get(id=row_id))


def went_live(reason):
    """A change is live in the API: clear the edge cache, then rebuild the site.
    True if the purge worked (the build result is shown separately)."""
    purged = purge.run(reason)
    request(reason)
    return purged
