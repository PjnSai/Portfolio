"""CV routes: the owner's versions and switches under /api/v1/admin/cv, and
the public status, view link, file and copy request under /api/v1/cv.

The public routes take no cookie or session, so they need no CSRF token; the
request guard still requires the site's own Origin on each POST. There is no
public route to a file by name or id: the file is reached only through a
one-minute link, from /cv/link to view it on the site, or from /cv/request to
download it.
"""

import logging

from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from core import (
    contact,
    cv,
    media,
    pages,
    ratelimit,
    responses,
    storage,
    turnstile,
    vital,
)
from core import contact_views as form
from core.authz import Level, admin_route
from core.guard import UNAVAILABLE
from core.models import ContactMessage, CvVersion

log = logging.getLogger(__name__)

POST = ("POST",)
STORAGE_ERRORS = (OSError, storage.NotConfigured)
CHUNK = 64 * 1024


def _when(value):
    return value.isoformat() if value else None


def describe(item):
    """What the owner sees of a version. Never the storage key."""
    return {
        "id": str(item.id),
        "size": item.size,
        "sha256": item.sha256,
        "created_at": _when(item.created_at),
        "is_live": item.is_live,
        "file": f"/api/v1/admin/cv/versions/{item.id}/file",
    }


def _field_error(message, status=400):
    return JsonResponse(
        {"detail": "Some fields need changing.", "errors": {"file": [message]}},
        status=status,
    )


def pdf_response(data, disposition):
    """The PDF with headers that keep it out of caches, search results and
    other sites' frames, and stop a browser reading it as anything else.
    Framing is refused by the API's own policy (core.headers)."""
    chunks = (data[i : i + CHUNK] for i in range(0, len(data), CHUNK))
    response = StreamingHttpResponse(chunks, content_type=cv.CONTENT_TYPE)
    response["Content-Length"] = str(len(data))
    response["Content-Disposition"] = f'{disposition}; filename="{cv.file_name()}"'
    response["X-Content-Type-Options"] = "nosniff"
    response["Cache-Control"] = "no-store"
    response["X-Robots-Tag"] = "noindex"
    return response


def _upload(request):
    if set(request.POST) or set(request.FILES) != {"file"}:
        return responses.bad_request()
    if len(request.FILES.getlist("file")) != 1:
        return responses.bad_request()
    upload = request.FILES["file"]
    data = upload.read()
    try:
        cv.check(data, upload.name, upload.content_type)
        media.count_upload()
        item = cv.add(data)
    except cv.TooLarge:
        return _field_error(cv.too_big_message(), status=413)
    except cv.Empty:
        return _field_error(cv.EMPTY)
    except cv.Encrypted:
        return _field_error(cv.ENCRYPTED)
    except cv.Active:
        return _field_error(cv.ACTIVE)
    except cv.Rejected:
        return _field_error(cv.NOT_A_PDF)
    except cv.Full:
        return JsonResponse({"detail": cv.FULL, "code": "cv_versions_full"}, status=409)
    except media.OverCap:
        return responses.too_many_requests(3600)
    except STORAGE_ERRORS as error:
        log.error("cv storage failed: %s", type(error).__name__)
        return responses.unavailable()
    return JsonResponse(describe(item), status=201)


@admin_route(Level.SESSION, methods=("GET", "POST"), form=True, elevate=POST)
def versions(request):
    if request.method == "POST":
        return _upload(request)
    if request.GET:
        return responses.bad_request()
    return JsonResponse(
        {
            "versions": [describe(item) for item in cv.versions()],
            "max_versions": cv.MAX_VERSIONS,
        }
    )


@admin_route(Level.ELEVATED, methods=POST)
def version_live(request, version_id):
    item = cv.set_live(version_id)
    if item is None:
        return responses.not_found()
    return JsonResponse(describe(item))


@admin_route(Level.SESSION)
def version_file(request, version_id):
    """Any version, live or not, so the owner can attach it to an email."""
    item = CvVersion.objects.filter(id=version_id).first()
    if item is None:
        return responses.not_found()
    try:
        data = cv.read(item)
    except STORAGE_ERRORS as error:
        log.error("cv storage failed: %s", type(error).__name__)
        return responses.unavailable()
    return pdf_response(data, "attachment")


@admin_route(Level.SESSION)
def switches(request):
    """The switches in force and any change waiting out its 24 hours. A change
    is asked for through /vital-actions/request, kind cv_switches."""
    waiting = vital.pending().filter(kind=cv.SWITCHES).order_by("requested_at")
    return JsonResponse(
        {**cv.switches(), "pending": [vital.describe(action) for action in waiting]}
    )


@admin_route(Level.SESSION)
def view_log(request):
    number = pages.requested_page(request.GET)
    if number is None:
        return responses.bad_request()
    return JsonResponse(pages.page_of(cv.views(), number, cv.describe_view))


@admin_route(Level.SESSION)
def view_days(request):
    if request.GET:
        return responses.bad_request()
    return JsonResponse(cv.day_counts())


# Public

# A minute in browsers and at the edge. A change of live version or switch
# shows within that; if the API cannot answer, the edge may keep the last good
# answer for a day (fail static).
STATUS_CACHE = "public, max-age=60, s-maxage=60, stale-if-error=86400"
LINK_FIELDS = {"turnstile"}


@csrf_exempt
@require_GET
def public_status(request):
    if request.GET:
        return responses.bad_request()
    wait = ratelimit.public_cap(request)
    if wait:
        return responses.too_many_requests(wait)
    return JsonResponse(cv.status(), headers={"Cache-Control": STATUS_CACHE})


def _unavailable(where, error):
    log.error("cv %s unavailable: %s", where, type(error).__name__)
    return responses.unavailable()


@csrf_exempt
def public_link(request):
    if request.method != "POST":
        return responses.method_not_allowed(("POST",))
    data, refusal = form.read_json(request, LINK_FIELDS)
    if refusal:
        return refusal
    try:
        return _link(data, ratelimit.client_address(request))
    except cv.Limited as limit:
        log.info("cv link outcome=rate_limited")
        return responses.too_many_requests(limit.seconds)
    except (*UNAVAILABLE, turnstile.Unavailable) as error:
        return _unavailable("link", error)


def _link(data, address):
    item = cv.live()
    if not cv.switches()["view"] or item is None:
        return responses.forbidden()
    cv.count_link_attempt(address)
    if not form.passes_turnstile(data.get("turnstile")):
        log.info("cv link outcome=bad_challenge")
        return responses.bad_challenge()
    cv.count_link()
    log.info("cv link outcome=issued")
    return JsonResponse(cv.link(item), headers={"Cache-Control": "no-store"})


@csrf_exempt
@require_GET
def public_file(request, token):
    """The live PDF for a good link: shown inline for a view link, sent as an
    attachment for a download link, each only while its switches are on. A
    bad, changed, expired or outdated link gets the same plain 404. The visit
    is logged, with its kind, once the file is in hand and before it is sent;
    if the log cannot be written, nothing is sent."""
    found = cv.linked(token)
    if found is None or request.GET:
        return responses.not_found()
    purpose, binding = found
    wait = ratelimit.public_cap(request)
    if wait:
        return responses.too_many_requests(wait)
    try:
        if not cv.link_allowed(purpose, cv.switches()):
            return responses.forbidden()
        item = cv.is_live_binding(binding)
        if item is None:
            return responses.not_found()
        data = cv.read(item)
        cv.log_view(item, request, purpose)
    except (*UNAVAILABLE, *STORAGE_ERRORS) as error:
        return _unavailable("file", error)
    return pdf_response(data, "attachment" if purpose == cv.DOWNLOAD else "inline")


@csrf_exempt
def public_request(request):
    """Ask for a copy. Stored as a message marked as a CV request, through the
    contact form's checks and limits, which it shares; the owner sees it in
    the inbox. With instant download on and a live CV, every sender who
    passes Turnstile and the limits also gets a download link for a minute,
    whether the request is stored, quarantined or dropped, so the answer
    never shows which."""
    if request.method != "POST":
        return responses.method_not_allowed(("POST",))
    data, refusal = form.read_json(request, cv.REQUEST_FIELDS)
    if refusal:
        return refusal
    try:
        on = cv.switches()
        if not on["request"]:
            return responses.forbidden()
        values, errors = cv.clean_request(data)
        if errors:
            return responses.invalid(errors)
        item = cv.live() if on["instant_download"] else None
        return form.accept(
            data,
            values,
            ratelimit.client_address(request),
            kind=ContactMessage.Kind.CV_REQUEST,
            repeat=cv.repeat_text(values),
            sent=_sent(on, item),
        )
    except contact.Limited as limit:
        log.info("cv request outcome=rate_limited")
        return responses.contact_limited(limit.seconds)
    except (*UNAVAILABLE, turnstile.Unavailable) as error:
        return form.unavailable(error)


def _sent(on, item):
    if not cv.instant_download(on, item):
        return responses.contact_sent

    def with_link():
        log.info("cv request download=issued")
        return responses.contact_sent(**cv.link(item, cv.DOWNLOAD))

    return with_link
