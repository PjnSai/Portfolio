"""The public CV (SPEC 3.7, 5.9, as the owner changed them in Phase 4C-1).

Only the public CV, with professional details alone, is stored, as a PDF. The
owner uploads versions behind a fresh passkey and chooses which one is live.
Visitors never get a lasting file URL. After a human check they get a link
that works for a minute: from /cv/link, to view the CV on the site; from
/cv/request, which also puts the request in the inbox, to download it, while
the instant download switch is on.

Storage keys never leave this module and the admin routes; nothing public
returns a key, an id or a hash.
"""

import hashlib
import hmac
import logging
import re
import time

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.db.models import Count
from django.db.models.functions import TruncDate

from core import audit, contact, ratelimit, storage
from core.models import CvDayCount, CvVersion, CvView, Owner, SiteSettings

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
STREAM_START = re.compile(rb"stream\r?\n")
STREAM_END = b"endstream"
NAME = re.compile(rb"/([^\x00\t\n\x0c\r ()<>\[\]{}/%]+)")
ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")


class Rejected(ValueError):
    """The file is not an acceptable PDF. The subclasses say why; the view
    answers with a fixed message for each, never with text from the error."""


class Empty(Rejected):
    pass


class Encrypted(Rejected):
    pass


class Active(Rejected):
    pass


class TooLarge(ValueError):
    pass


def too_big_message():
    return TOO_BIG.format(settings.CV_MAX_BYTES // (1024 * 1024))


class Full(Exception):
    pass


def _outside_streams(data):
    """The bytes with every stream body cut out. One pass with find(), so the
    time grows with the file size however the file is built; a lazy regex
    over 'stream' runs repeated would take quadratic time."""
    parts = []
    pos = 0
    while True:
        start = STREAM_START.search(data, pos)
        if start is None:
            parts.append(data[pos:])
            break
        end = data.find(STREAM_END, start.end())
        if end == -1:
            # No end marker: keep the rest in view rather than hide it.
            parts.append(data[pos:])
            break
        parts.append(data[pos : start.start()])
        parts.append(b"stream endstream")
        pos = end + len(STREAM_END)
    return b"".join(parts)


def _names(data):
    outside = _outside_streams(data)
    return {
        ESCAPE.sub(lambda m: bytes([int(m.group(1), 16)]), name)
        for name in NAME.findall(outside)
    }


def check(data, filename, content_type):
    """Raise Rejected or TooLarge unless this is a plain, unencrypted PDF whose
    declared type and name agree with its bytes."""
    if not data:
        raise Empty
    if len(data) > settings.CV_MAX_BYTES:
        raise TooLarge
    if content_type != CONTENT_TYPE or not str(filename).lower().endswith(".pdf"):
        raise Rejected
    tail = data[-TAIL:]
    if not data.startswith(b"%PDF-") or b"%%EOF" not in tail:
        raise Rejected
    # Every PDF ends with a pointer to its cross-reference table.
    if b"startxref" not in tail:
        raise Rejected
    names = _names(data)
    if b"Encrypt" in names:
        raise Encrypted
    if names & ACTIVE_NAMES:
        raise Active


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


# The three switches: view, request and instant download. All are on until the
# owner changes them, and each change is a vital action (core.vital), turning
# off as much as turning on: one kind, whose payload holds all three values.
# Instant download only counts while request is on.

SWITCHES = "cv_switches"
SWITCH_NAMES = ("view", "request", "instant_download")
COLUMNS = {
    "view": "cv_view_enabled",
    "request": "cv_request_enabled",
    "instant_download": "cv_instant_download_enabled",
}


def switches():
    """{"view", "request", "instant_download"}. Reading them never creates the
    settings row."""
    row = SiteSettings.objects.values_list(
        *(COLUMNS[name] for name in SWITCH_NAMES)
    ).first()
    return dict(zip(SWITCH_NAMES, row or (True,) * len(SWITCH_NAMES), strict=True))


def clean_switches(payload):
    if not isinstance(payload, dict) or set(payload) != set(SWITCH_NAMES):
        return None
    if not all(isinstance(payload[name], bool) for name in payload):
        return None
    return {name: payload[name] for name in SWITCH_NAMES}


def set_switches(payload):
    """Run by the vital action, inside its transaction."""
    from core import content

    row = content.site_settings()
    SiteSettings.objects.filter(id=row.id).update(
        **{COLUMNS[name]: payload[name] for name in SWITCH_NAMES}
    )
    audit.record(
        "cv_switches_changed", **{name: payload[name] for name in SWITCH_NAMES}
    )


WORD = re.compile(r"[^A-Za-z0-9]+")


def file_name():
    """From the published site title: letters, digits and hyphens only."""
    row = SiteSettings.objects.values_list("published", flat=True).first() or {}
    title = row.get("title") if isinstance(row, dict) else None
    clean = WORD.sub("-", title if isinstance(title, str) else "").strip("-")[:60]
    return f"{clean.strip('-')}-CV.pdf" if clean else "cv.pdf"


# What visitors may know: whether they can view or ask, and the day of the
# live version. Never a key, an id or a hash.


def status():
    item, on = live(), switches()
    answer = {
        "can_view": bool(on["view"] and item),
        "can_request": on["request"],
    }
    if instant_download(on, item):
        answer["instant_download"] = True
    answer["updated"] = item.created_at.date().isoformat() if item else None
    return answer


def instant_download(on, item):
    """Whether a copy request is answered with a download link."""
    return bool(on["instant_download"] and on["request"] and item)


# The links. A visitor who passes Turnstile and the limits gets a path that
# works for LINK_SECONDS: from /cv/link to view the CV on the site, or from
# /cv/request to download it. Each is signed for its purpose alone, so one
# never works as the other, and bound to the live version by a keyed hash of
# its id, so it names no id and stops working as soon as another version goes
# live.

VIEW = "view"
DOWNLOAD = "download"
LINK_SALTS = {VIEW: "core.cv.view-link", DOWNLOAD: "core.cv.download-link"}
LINK_SECONDS = 60
TOKEN_MAX = 200
HOUR = 3600
DAY = 86400


class Limited(Exception):
    def __init__(self, seconds):
        super().__init__("rate limited")
        self.seconds = seconds


def _over(bucket, seconds, limit):
    now = time.time()
    window = int(now // seconds)
    if ratelimit.hit(f"cv:{bucket}:{window}", seconds) > limit:
        raise Limited(int(seconds - now % seconds) or 1)


def count_link_attempt(address):
    """Per client, before the human check, so a bot cannot hammer Turnstile."""
    key = contact.address_hash(address)
    _over(f"address:{key}", HOUR, settings.CV_VIEW_PER_ADDRESS_PER_HOUR)


def count_link():
    """The whole site's day, counted only for visitors who passed the check."""
    _over("day", DAY, settings.CV_VIEW_DAILY_CAP)


def _binding(item):
    key = settings.SECRET_KEY.encode()
    message = f"cv-version:{item.id}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()[:32]


def _signer(purpose):
    return signing.TimestampSigner(salt=LINK_SALTS[purpose])


def link_token(item, purpose=VIEW):
    return _signer(purpose).sign(_binding(item))


def link(item, purpose=VIEW):
    return {
        "url": f"/api/v1/cv/file/{link_token(item, purpose)}",
        "expires_in": LINK_SECONDS,
    }


def linked(token):
    """(purpose, binding) for a good, unexpired token, else None. Needs nothing
    but the secret key."""
    if not isinstance(token, str) or not 0 < len(token) <= TOKEN_MAX:
        return None
    for purpose in LINK_SALTS:
        try:
            return purpose, _signer(purpose).unsign(token, max_age=LINK_SECONDS)
        except signing.BadSignature:
            continue
    return None


def link_allowed(purpose, on):
    """Whether a link of this purpose may still be used with the switches as
    they are now."""
    if purpose == DOWNLOAD:
        return bool(on["instant_download"] and on["request"])
    return bool(on["view"])


def is_live_binding(binding):
    """The live version, if the binding names it, else None."""
    item = live()
    if item is None or not hmac.compare_digest(binding, _binding(item)):
        return None
    return item


# The view log: no address, no email, no free text.

COUNTRY = re.compile(r"[A-Z]{2}")
AGENT_MAX = 200


def _country(request):
    value = request.headers.get("Cf-Ipcountry", "")
    # XX is Cloudflare's "unknown"; T1 (Tor) fails the pattern.
    return value if COUNTRY.fullmatch(value) and value != "XX" else ""


def _agent(request):
    value = contact.HIDDEN.sub("", request.headers.get("User-Agent", ""))
    return value.strip()[:AGENT_MAX]


def log_view(item, request, purpose=VIEW):
    return CvView.objects.create(
        version=item.id,
        kind=CvView.Kind.DOWNLOAD if purpose == DOWNLOAD else CvView.Kind.VIEW,
        country=_country(request),
        user_agent=_agent(request),
    )


# A request for a copy, through the contact form's pipeline (core.contact,
# core.contact_views). The owner replies by hand; the site sends nothing.

REQUEST_FIELDS = {"name", "email", "note", "website", "elapsed", "turnstile"}
REQUEST_TEXT = "Request for a copy of the CV."
NOTE_HEADING = "Note from the sender:"
NOTE_MAX = 500


def _clean_note(value):
    value = contact.LINE_BREAKS.sub("\n", value.replace("\r\n", "\n"))
    value = contact.HIDDEN.sub("", value.replace("\t", " ")).strip()
    if len(value) > NOTE_MAX:
        return value, f"Use {NOTE_MAX} characters or fewer."
    return value, None


def clean_request(data):
    """(values, errors) in the form contact.store takes: a fixed body naming
    the request, then the note if there is one. The name is optional."""
    values, errors = {"reason": ""}, {}
    email = data.get("email")
    if "email" not in data:
        errors["email"] = ["This field is required."]
    elif not isinstance(email, str):
        errors["email"] = ["Enter text."]
    else:
        values["email"], problem = contact._clean_field("email", email)
        if problem:
            errors["email"] = [problem]
    name = data.get("name", "")
    if not isinstance(name, str):
        errors["name"] = ["Enter text."]
    elif name.strip():
        values["name"], problem = contact._clean_field("name", name)
        if problem:
            errors["name"] = [problem]
    else:
        values["name"] = ""
    note = data.get("note", "")
    if not isinstance(note, str):
        errors["note"] = ["Enter text."]
        note = ""
    note, problem = _clean_note(note)
    if problem:
        errors["note"] = [problem]
    values["body"] = (
        f"{REQUEST_TEXT}\n\n{NOTE_HEADING}\n{note}" if note else REQUEST_TEXT
    )
    return values, errors


def repeat_text(values):
    """What counts as asking again: the same email with the same note. The
    body alone would make every request without a note look like a repeat."""
    return f"cv-request\n{values['email'].lower()}\n{values['body']}"


def describe_view(row):
    return {
        "id": str(row.id),
        "at": row.at.isoformat(),
        "version": str(row.version),
        "kind": row.kind,
        "country": row.country,
        "user_agent": row.user_agent,
    }


def views():
    return CvView.objects.all()


def day_counts():
    """Views per UTC day, newest first: the totals kept by the daily job for
    days past the log's period, and the rows still in the log for the rest."""
    totals = dict(CvDayCount.objects.values_list("day", "count"))
    recent = (
        CvView.objects.annotate(day=TruncDate("at"))
        .values("day")
        .annotate(n=Count("id"))
        .values_list("day", "n")
    )
    for day, n in recent:
        totals[day] = totals.get(day, 0) + n
    days = [
        {"day": day.isoformat(), "count": totals[day]}
        for day in sorted(totals, reverse=True)
    ]
    return {"days": days, "total": sum(totals.values())}
