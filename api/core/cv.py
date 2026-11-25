"""The public CV (SPEC 3.7, 5.9, as the owner changed them in Phase 4C-1).

Only the public CV, with professional details alone, is stored, as a PDF. The
owner uploads versions behind a fresh passkey and chooses which one is live.
Visitors never get a file URL or a download: after a human check they get a
link that works for a minute, for a viewer on the site. A copy is had only by
asking through the inbox (core.cv_request), and the owner answers by hand.

Storage keys never leave this module and the admin routes; nothing public
returns a key, an id or a hash.
"""

import hashlib
import logging
import re

from django.conf import settings
from django.db import transaction

from core import audit, storage
from core.models import CvVersion, Owner, SiteSettings

log = logging.getLogger(__name__)

MAX_VERSIONS = 10
CONTENT_TYPE = "application/pdf"
# %%EOF must sit near the end; some tools add a few bytes after it.
TAIL = 1024

NOT_A_PDF = "Choose a PDF file."
EMPTY = "That file is empty."
TOO_BIG = "Use a PDF under {} MB."
ENCRYPTED = "That PDF is protected with a password. Upload one without a password."
ACTIVE = (
    "That PDF holds scripts, actions that run on opening or attached files. "
    "Export it again as a plain PDF."
)
FULL = f"Keep at most {MAX_VERSIONS} versions. Delete one before uploading another."

# Names in a PDF that run something or carry another file. This is a
# heuristic, not a guarantee: a name inside a compressed object stream is not
# seen, and a PDF reader may still do things no name here covers. It is
# enough for its job, because the only uploader is the owner, behind a fresh
# passkey, with his own file; it stops an export setting or a template from
# slipping a script onto the site unnoticed.
ACTIVE_NAMES = frozenset(
    {b"JavaScript", b"JS", b"OpenAction", b"AA", b"Launch", b"EmbeddedFile"}
)
# Stream bodies are page content, fonts and images: binary, and full of byte
# runs that look like names by chance. Names that matter sit in dictionaries
# outside them.
STREAM = re.compile(rb"stream\r?\n.*?endstream", re.DOTALL)
NAME = re.compile(rb"/([^\x00\t\n\x0c\r ()<>\[\]{}/%]+)")
ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")


class Rejected(ValueError):
    pass


class TooLarge(ValueError):
    pass


class Full(Exception):
    pass


def _names(data):
    outside = STREAM.sub(b"stream endstream", data)
    return {
        ESCAPE.sub(lambda m: bytes([int(m.group(1), 16)]), name)
        for name in NAME.findall(outside)
    }


def check(data, filename, content_type):
    """Raise Rejected or TooLarge unless this is a plain, unencrypted PDF whose
    declared type and name agree with its bytes."""
    if not data:
        raise Rejected(EMPTY)
    if len(data) > settings.CV_MAX_BYTES:
        raise TooLarge(TOO_BIG.format(settings.CV_MAX_BYTES // (1024 * 1024)))
    if content_type != CONTENT_TYPE or not str(filename).lower().endswith(".pdf"):
        raise Rejected(NOT_A_PDF)
    tail = data[-TAIL:]
    if not data.startswith(b"%PDF-") or b"%%EOF" not in tail:
        raise Rejected(NOT_A_PDF)
    # Every PDF ends with a pointer to its cross-reference table.
    if b"startxref" not in tail:
        raise Rejected(NOT_A_PDF)
    names = _names(data)
    if b"Encrypt" in names:
        raise Rejected(ENCRYPTED)
    if names & ACTIVE_NAMES:
        raise Rejected(ACTIVE)


def add(data):
    """Store a checked PDF under a new random key and record it. The count, the
    file and the row are done under one lock, so two uploads cannot pass the
    limit together; if anything fails, the file is removed again."""
    store = storage.cv_backend()
    key = storage.new_cv_key()
    saved = False
    try:
        with transaction.atomic():
            Owner.objects.select_for_update().get()
            if CvVersion.objects.count() >= MAX_VERSIONS:
                raise Full
            store.save(key, data, CONTENT_TYPE)
            saved = True
            item = CvVersion.objects.create(
                storage_key=key,
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
            audit.record("cv_uploaded", version=str(item.id), size=item.size)
    except Exception:
        if saved:
            try:
                store.delete(key)
            except Exception:  # noqa: S110 - the first error is the one to report.
                pass
        raise
    return item


def versions():
    return CvVersion.objects.all()


def live():
    return CvVersion.objects.filter(is_live=True).first()


def set_live(version_id):
    """Make one version the live one; the one before stops being live. Setting
    an older version live is the rollback."""
    with transaction.atomic():
        item = CvVersion.objects.select_for_update().filter(id=version_id).first()
        if item is None:
            return None
        CvVersion.objects.filter(is_live=True).exclude(id=item.id).update(is_live=False)
        CvVersion.objects.filter(id=item.id).update(is_live=True)
        item.is_live = True
        audit.record("cv_live_changed", version=str(item.id))
    return item


def deletable(version_id):
    return CvVersion.objects.filter(id=version_id, is_live=False).exists()


def delete_version(version_id):
    """Run by the permanent-delete vital action. False if the version is gone
    or has become live during the wait. The file goes once the row is gone for
    good; if that fails, an unreachable file is left, which is logged."""
    item = (
        CvVersion.objects.select_for_update()
        .filter(id=version_id, is_live=False)
        .first()
    )
    if item is None:
        return False
    key = item.storage_key
    CvVersion.objects.filter(id=item.id).delete()
    audit.record("cv_version_deleted", version=str(version_id))
    transaction.on_commit(lambda: _remove_file(key))
    return True


def _remove_file(key):
    try:
        storage.cv_backend().delete(key)
    except Exception as error:
        log.error("cv file not removed: %s", type(error).__name__)


def read(item):
    """The file's bytes. Raises OSError or storage.NotConfigured if the store
    cannot give them."""
    return storage.cv_backend().read(item.storage_key)


# The two switches. Both are on until the owner changes them, and each change
# is a vital action (core.vital), turning off as much as turning on: one kind,
# whose payload holds both values.

SWITCHES = "cv_switches"


def switches():
    """{"view", "request"}. Reading them never creates the settings row."""
    row = SiteSettings.objects.values_list(
        "cv_view_enabled", "cv_request_enabled"
    ).first()
    view, request = row or (True, True)
    return {"view": view, "request": request}


def clean_switches(payload):
    if not isinstance(payload, dict) or set(payload) != {"view", "request"}:
        return None
    if not all(isinstance(payload[name], bool) for name in payload):
        return None
    return {"view": payload["view"], "request": payload["request"]}


def set_switches(payload):
    """Run by the vital action, inside its transaction."""
    from core import content

    row = content.site_settings()
    SiteSettings.objects.filter(id=row.id).update(
        cv_view_enabled=payload["view"], cv_request_enabled=payload["request"]
    )
    audit.record(
        "cv_switches_changed", view=payload["view"], request=payload["request"]
    )


WORD = re.compile(r"[^A-Za-z0-9]+")


def file_name():
    """From the published site title: letters, digits and hyphens only."""
    row = SiteSettings.objects.values_list("published", flat=True).first() or {}
    title = row.get("title") if isinstance(row, dict) else None
    clean = WORD.sub("-", title if isinstance(title, str) else "").strip("-")[:60]
    return f"{clean.strip('-')}-CV.pdf" if clean else "cv.pdf"
