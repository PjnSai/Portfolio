"""Inbox routes under /api/v1/admin/messages. All need a signed-in owner."""

import re
from datetime import date

from django.http import JsonResponse

from core import blocklist, inbox, limits, pages, responses, retention, serializers
from core.authz import Level, admin_route

POST = ("POST",)
READ_EDIT = ("GET", "PATCH")
STATUSES = {"all", "new", "read", "replied", "archived", "spam"}


def _valid(serializer_class, data):
    serializer = serializer_class(data=data)
    if serializer.is_valid():
        return serializers.as_json(serializer.validated_data), None
    return None, responses.invalid(serializer.errors)


FILTERS = ("status", "q", "reason", "since", "until")
REASONS = {"hiring", "project", "other", "none"}
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
SEARCH_MAX = 100


def _day(value):
    """A date from YYYY-MM-DD, None if absent, False if it is not a real date."""
    if value is None:
        return None
    if not DAY.fullmatch(value):
        return False
    try:
        return date.fromisoformat(value)
    except ValueError:
        return False


@admin_route(Level.SESSION)
def message_list(request):
    params = request.GET
    number = pages.requested_page(params, allowed=FILTERS)
    status = params.get("status")
    search = params.get("q", "").strip()
    reason = params.get("reason")
    since, until = _day(params.get("since")), _day(params.get("until"))
    refused = (
        number is None
        or (status is not None and status not in STATUSES)
        or len(search) > SEARCH_MAX
        or not search.isprintable()
        or (reason is not None and reason not in REASONS)
        or since is False
        or until is False
    )
    if refused:
        return responses.bad_request()
    body = pages.page_of(
        inbox.listing(status, search, reason, since, until),
        number,
        inbox.summary,
        size=inbox.PAGE_SIZE,
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


@admin_route(Level.ELEVATED, methods=POST)
def message_block(request, message_id):
    data, error = _valid(serializers.BlockNote, request.json)
    if error:
        return error
    try:
        entry, found = blocklist.block_message(
            message_id, data.get("note", ""), data["keep_address"]
        )
    except blocklist.Full:
        return responses.conflict("blocklist_full")
    if found is None:
        return responses.not_found()
    return JsonResponse(
        {"entry": blocklist.describe(entry), "message": inbox.detail(found)}
    )


@admin_route(Level.SESSION, methods=("GET", "POST"), elevate=POST)
def blocklist_view(request):
    if request.method == "POST":
        data, error = _valid(serializers.Block, request.json)
        if error:
            return error
        try:
            entry, _ = blocklist.block_email(
                data["email"], data.get("note", ""), data["keep_address"]
            )
        except blocklist.Full:
            return responses.conflict("blocklist_full")
        return JsonResponse(blocklist.describe(entry), status=201)
    return JsonResponse(blocklist.listing())


@admin_route(Level.ELEVATED, methods=POST)
def blocklist_remove(request, entry_id):
    _, error = _valid(serializers.Nothing, request.json)
    if error:
        return error
    if not blocklist.remove(entry_id):
        return responses.not_found()
    return JsonResponse({"removed": True})


@admin_route(Level.ELEVATED, methods=POST)
def blocklist_renew(request, entry_id):
    _, error = _valid(serializers.Nothing, request.json)
    if error:
        return error
    try:
        entry = blocklist.renew(entry_id)
    except blocklist.Full:
        return responses.conflict("blocklist_full")
    if entry is None:
        return responses.not_found()
    return JsonResponse(blocklist.describe(entry))


def _retention():
    spam, other = retention.periods()
    return {
        "spam_days": spam,
        "message_days": other,
        "min_days": retention.MIN_DAYS,
        "max_days": retention.MAX_DAYS,
    }


@admin_route(Level.SESSION, methods=READ_EDIT, elevate=("PATCH",))
def retention_view(request):
    if request.method == "PATCH":
        data, error = _valid(serializers.Retention, request.json)
        if error:
            return error
        retention.save(data["spam_days"], data["message_days"])
    return JsonResponse(_retention())


@admin_route(Level.SESSION, methods=READ_EDIT, elevate=("PATCH",))
def limits_view(request):
    if request.method == "PATCH":
        data, error = _valid(serializers.Limits, request.json)
        if error:
            return error
        limits.save(data)
    return JsonResponse(limits.describe())
