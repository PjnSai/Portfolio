"""Inbox routes under /api/v1/admin/messages. All need a signed-in owner."""

from django.http import JsonResponse

from core import inbox, pages, responses, serializers
from core.authz import Level, admin_route

POST = ("POST",)
STATUSES = {"all", "new", "read", "replied", "archived", "spam"}


def _valid(serializer_class, data):
    serializer = serializer_class(data=data)
    if serializer.is_valid():
        return serializers.as_json(serializer.validated_data), None
    return None, responses.invalid(serializer.errors)


@admin_route(Level.SESSION)
def message_list(request):
    number = pages.requested_page(request.GET, allowed=("status",))
    status = request.GET.get("status")
    if number is None or (status is not None and status not in STATUSES):
        return responses.bad_request()
    body = pages.page_of(
        inbox.listing(status), number, inbox.summary, size=inbox.PAGE_SIZE
    )
    return JsonResponse({**body, "counts": inbox.counts()})


@admin_route(Level.SESSION)
def message(request, message_id):
    found = inbox.open_message(message_id)
    if found is None:
        return responses.not_found()
    return JsonResponse(inbox.detail(found))


@admin_route(Level.SESSION, methods=POST)
def message_status(request, message_id):
    data, error = _valid(serializers.InboxStatus, request.json)
    if error:
        return error
    try:
        found = inbox.set_status(message_id, data["status"])
    except inbox.Refused:
        return responses.conflict()
    if found is None:
        return responses.not_found()
    return JsonResponse(inbox.detail(found))


@admin_route(Level.SESSION, methods=POST)
def message_notes(request, message_id):
    data, error = _valid(serializers.InboxNote, request.json)
    if error:
        return error
    note = inbox.add_note(message_id, data["text"])
    if note is None:
        return responses.not_found()
    return JsonResponse(inbox.describe_note(note), status=201)


@admin_route(Level.SESSION, methods=POST)
def message_responded(request, message_id):
    data, error = _valid(serializers.InboxResponse, request.json)
    if error:
        return error
    try:
        note = inbox.log_response(message_id, data.get("text", ""))
    except inbox.Refused:
        return responses.conflict()
    if note is None:
        return responses.not_found()
    return JsonResponse(inbox.describe_note(note), status=201)


@admin_route(Level.SESSION, methods=POST)
def message_keep(request, message_id):
    data, error = _valid(serializers.InboxKeep, request.json)
    if error:
        return error
    found = inbox.set_kept(message_id, data["kept"])
    if found is None:
        return responses.not_found()
    return JsonResponse(inbox.detail(found))


@admin_route(Level.SESSION, methods=POST)
def message_not_spam(request, message_id):
    _, error = _valid(serializers.Nothing, request.json)
    if error:
        return error
    try:
        found = inbox.not_spam(message_id)
    except inbox.Refused:
        return responses.conflict()
    if found is None:
        return responses.not_found()
    return JsonResponse(inbox.detail(found))


@admin_route(Level.SESSION, methods=POST)
def message_delete(request, message_id):
    _, error = _valid(serializers.Nothing, request.json)
    if error:
        return error
    if not inbox.delete(message_id):
        return responses.not_found()
    return JsonResponse({})
