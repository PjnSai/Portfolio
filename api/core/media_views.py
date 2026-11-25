"""Media library routes for the admin, the public image route, the public site
document and the cache purge status."""

import hashlib
import logging

from django.http import HttpResponse, JsonResponse
from django.utils.cache import get_conditional_response
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from core import (
    abuse,
    content,
    deploy,
    media,
    pages,
    purge,
    ratelimit,
    responses,
    serializers,
    storage,
)
from core.authz import Level, admin_route
from core.models import Media

log = logging.getLogger(__name__)

POST = ("POST",)
STORAGE_ERRORS = (OSError, storage.NotConfigured)
# Published content is purged from the edge on every change. If a purge fails,
# the edge copy is still at most two minutes old (the rebuild debounce), and
# browsers check again after a minute; the ETag makes a check cheap. If the API
# cannot answer, the edge may serve the last good copy for a week (fail static).
SITE_CACHE = (
    "public, max-age=60, s-maxage=120, stale-while-revalidate=60, stale-if-error=604800"
)
FILE_CACHE = "public, max-age=31536000, immutable"


def _when(value):
    return value.isoformat() if value else None


def _describe(item):
    return {
        "id": str(item.id),
        "alt": item.alt,
        "width": item.width,
        "height": item.height,
        "size": item.size,
        "created_at": _when(item.created_at),
        "variants": item.variants,
        "preview": f"/api/v1/admin/media/{item.id}/file",
    }


def _live(media_id):
    return Media.objects.filter(id=media_id, trashed_at=None).first()


def _field_error(name, message, status=400):
    return JsonResponse(
        {"detail": "Some fields need changing.", "errors": {name: [message]}},
        status=status,
    )


def _upload_form(request):
    """(file, alt) from the form, or the refusal to send."""
    if set(request.POST) - {"alt"} or set(request.FILES) != {"file"}:
        return None, responses.bad_request()
    if any(len(v) != 1 for _, v in [*request.POST.lists(), *request.FILES.lists()]):
        return None, responses.bad_request()
    alt = serializers.MediaAlt(data={"alt": request.POST.get("alt", "")})
    if not alt.is_valid():
        return None, responses.invalid(alt.errors)
    return (request.FILES["file"], alt.validated_data["alt"]), None


@admin_route(Level.SESSION, methods=("GET", "POST"), form=True)
def library(request):
    if request.method == "GET":
        number = pages.requested_page(request.GET)
        if number is None:
            return responses.bad_request()
        return JsonResponse(pages.page_of(media.live(), number, _describe))
    form, refusal = _upload_form(request)
    if refusal:
        return refusal
    upload, alt = form
    try:
        media.count_upload()
        item = media.add(upload.read(), alt)
    except media.TooLarge:
        return _field_error("file", "Use an image under 8 MB.", status=413)
    except media.Rejected as error:
        return _field_error("file", str(error))
    except media.OverCap:
        return abuse.refused(abuse.RATE_LIMITED, responses.too_many_requests(3600))
    except STORAGE_ERRORS as error:
        log.error("media storage failed: %s", type(error).__name__)
        return responses.unavailable()
    return JsonResponse(_describe(item), status=201)


@admin_route(Level.SESSION, methods=("GET", "PATCH"))
def media_item(request, media_id):
    item = _live(media_id)
    if item is None:
        return responses.not_found()
    if request.method == "PATCH":
        alt = serializers.MediaAlt(data=request.json)
        if not alt.is_valid():
            return responses.invalid(alt.errors)
        media.set_alt(item, alt.validated_data["alt"])
    return JsonResponse(_describe(item))


@admin_route(Level.SESSION, methods=POST)
def media_trash(request, media_id):
    item = _live(media_id)
    if item is None:
        return responses.not_found()
    media.trash(item)
    deploy.went_live("media_trashed")
    return JsonResponse({})


@admin_route(Level.SESSION, methods=POST)
def media_restore(request, media_id):
    item = Media.objects.filter(id=media_id).first()
    if item is None:
        return responses.not_found()
    try:
        content.restore(item)
    except content.Refused:
        return responses.conflict()
    return JsonResponse(_describe(item))


def _image(item, name, cache_control):
    try:
        data = storage.backend().read(name)
    except STORAGE_ERRORS as error:
        log.error("media storage failed: %s", type(error).__name__)
        return responses.unavailable()
    return HttpResponse(
        data,
        content_type="image/webp",
        headers={
            "Cache-Control": cache_control,
            "Content-Disposition": "inline",
        },
    )


@admin_route(Level.SESSION)
def media_file(request, media_id):
    """The smallest size, for previews in the admin, published or not."""
    item = _live(media_id)
    if item is None or not item.variants:
        return responses.not_found()
    return _image(item, item.variants[0]["name"], "no-store")


@admin_route(Level.SESSION)
def cache_status(request):
    return JsonResponse({"purge_failed_at": _when(purge.failed_at())})


@admin_route(Level.SESSION, methods=("GET", "POST"))
def site_deploy(request):
    """The last rebuild of the static site; POST asks for one now."""
    if request.method == "POST":
        return JsonResponse(deploy.request("manual"))
    return JsonResponse(deploy.status())


@admin_route(Level.SESSION, methods=POST)
def cache_purge(request):
    done = purge.run("retry")
    return JsonResponse(
        {"cache_purged": done, "purge_failed_at": _when(purge.failed_at())}
    )


# Public


@csrf_exempt
@require_GET
def public_file(request, name):
    """A published image. Anything else, including a valid name for an image
    that is not on the site, is a plain 404."""
    wait = ratelimit.public_cap(request)
    if wait:
        return abuse.refused(abuse.RATE_LIMITED, responses.too_many_requests(wait))
    item = media.find_variant(name)
    if item is None or not content.is_published_media(item):
        return responses.not_found()
    return _image(item, name, FILE_CACHE)


@csrf_exempt
@require_GET
def public_site(request):
    if request.GET:
        return responses.bad_request()
    wait = ratelimit.public_cap(request)
    if wait:
        return abuse.refused(abuse.RATE_LIMITED, responses.too_many_requests(wait))
    response = JsonResponse(
        content.public_site(), headers={"Cache-Control": SITE_CACHE}
    )
    response["ETag"] = f'"{hashlib.sha256(response.content).hexdigest()[:32]}"'
    return get_conditional_response(request, etag=response["ETag"], response=response)
