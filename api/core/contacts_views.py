"""Contact routes under /api/v1/admin/contacts. Reading and editing need a
signed-in owner; deleting needs a passkey confirmed in the last few minutes."""

from django.http import JsonResponse

from core import contacts, pages, responses
from core.authz import Level, admin_route
from core.inbox_views import SEARCH_MAX, _valid
from core.models import Contact
from core.serializers import ContactCreate, ContactEdit, ContactLink, Nothing

POST = ("POST",)
FILTERS = ("q", "tag", "due")
TAG_MAX = 30


@admin_route(Level.SESSION, methods=("GET", "POST"))
def contact_list(request):
    if request.method == "POST":
        data, error = _valid(ContactCreate, request.json)
        if error:
            return error
        message_id = data.pop("message")
        try:
            found = contacts.create(message_id, data)
        except contacts.Taken:
            return responses.conflict("contact_exists")
        if found is None:
            return responses.not_found()
        return JsonResponse(contacts.detail(found), status=201)
    params = request.GET
    number = pages.requested_page(params, allowed=FILTERS)
    search = params.get("q", "").strip()
    tag = params.get("tag", "").strip()
    due = params.get("due")
    refused = (
        number is None
        or len(search) > SEARCH_MAX
        or not search.isprintable()
        or len(tag) > TAG_MAX
        or not tag.isprintable()
        or due not in (None, "1")
    )
    if refused:
        return responses.bad_request()
    body = pages.page_of(
        contacts.listing(search, tag, due == "1"),
        number,
        contacts.summary,
        size=contacts.PAGE_SIZE,
    )
    return JsonResponse(body)


@admin_route(Level.SESSION, methods=("GET", "PATCH"))
def contact(request, contact_id):
    if request.method == "PATCH":
        data, error = _valid(ContactEdit, request.json)
        if error:
            return error
        found = contacts.edit(contact_id, data)
    else:
        found = Contact.objects.filter(id=contact_id).first()
    if found is None:
        return responses.not_found()
    return JsonResponse(contacts.detail(found))


def _link(request, contact_id, linked):
    data, error = _valid(ContactLink, request.json)
    if error:
        return error
    try:
        found = contacts.link(contact_id, data["message"], linked)
    except contacts.OtherSender:
        return responses.conflict("different_sender")
    if found is None:
        return responses.not_found()
    return JsonResponse(contacts.detail(found))


@admin_route(Level.SESSION, methods=POST)
def contact_link(request, contact_id):
    return _link(request, contact_id, True)


@admin_route(Level.SESSION, methods=POST)
def contact_unlink(request, contact_id):
    return _link(request, contact_id, False)


@admin_route(Level.ELEVATED, methods=POST)
def contact_delete(request, contact_id):
    _, error = _valid(Nothing, request.json)
    if error:
        return error
    if not contacts.delete(contact_id):
        return responses.not_found()
    return JsonResponse({"deleted": True})
