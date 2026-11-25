"""CV routes: the owner's versions under /api/v1/admin/cv."""

import logging

from django.http import JsonResponse, StreamingHttpResponse

from core import cv, media, responses, storage
from core.authz import Level, admin_route
from core.models import CvVersion

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
    except cv.TooLarge as error:
        return _field_error(str(error), status=413)
    except cv.Rejected as error:
        return _field_error(str(error))
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
