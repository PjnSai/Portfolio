"""Admin routes for sections, items and the trash. All need a signed-in session;
permanent deletion goes through the vital-action routes instead."""

from django.db import transaction
from django.http import JsonResponse

from core import content, pages, responses, serializers
from core.authz import Level, admin_route
from core.models import Revision, Section, SectionItem

POST = ("POST",)
READ_EDIT = ("GET", "PATCH")


def _valid(serializer_class, data, **kwargs):
    """(validated data, None) or (None, the 400 response to send)."""
    serializer = serializer_class(data=data, **kwargs)
    if serializer.is_valid():
        return serializers.as_json(serializer.validated_data), None
    return None, responses.invalid(serializer.errors)


def _live_section(section_id):
    return Section.objects.filter(id=section_id, trashed_at=None).first()


def _live_item(item_id):
    return SectionItem.objects.filter(
        id=item_id, trashed_at=None, section__trashed_at=None
    ).first()


def _when(value):
    return value.isoformat() if value else None


def _section_summary(section):
    return {
        "id": str(section.id),
        "type": section.type,
        "title": section.draft.get("title", ""),
        "visible": section.visible,
        "position": section.position,
        "holds_items": content.holds_items(section),
        "published_at": _when(section.published_at),
    }


def _section_detail(section):
    return {
        **_section_summary(section),
        "draft": section.draft,
        "unpublished_changes": content.unpublished_changes(section),
    }


def _item(item):
    return {
        "id": str(item.id),
        "section": str(item.section_id),
        "visible": item.visible,
        "position": item.position,
        "label": content.item_label(item),
        "data": item.draft,
    }


def _page(request, rows, describe):
    number = pages.requested_page(request.GET)
    if number is None:
        return responses.bad_request()
    return JsonResponse(pages.page_of(rows, number, describe))


def _refused(action, *args):
    try:
        action(*args)
    except content.Refused:
        return responses.conflict()
    return None


# Sections


@admin_route(Level.SESSION, methods=("GET", "POST"))
def sections(request):
    if request.method == "GET":
        return _page(request, content.live_sections(), _section_summary)
    data, error = _valid(serializers.NewSection, request.json)
    if error:
        return error
    try:
        section = content.add_section(data["type"], data["title"])
    except content.Refused:
        return responses.conflict()
    return JsonResponse(_section_detail(section), status=201)


@admin_route(Level.SESSION, methods=POST)
def sections_reorder(request):
    data, error = _valid(serializers.Order, request.json)
    if error:
        return error
    if not content.reorder(content.live_sections(), data["ids"], "sections_reordered"):
        return responses.bad_request()
    return JsonResponse({})


@admin_route(Level.SESSION, methods=READ_EDIT)
def section(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    if request.method == "PATCH":
        changes, error = _valid(serializers.SectionContent, request.json, partial=True)
        if error:
            return error
        content.edit_section(found, changes)
    return JsonResponse(_section_detail(found))


@admin_route(Level.SESSION, methods=POST)
def section_visibility(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    data, error = _valid(serializers.Visibility, request.json)
    if error:
        return error
    content.set_visible(found, data["visible"])
    return JsonResponse(_section_summary(found))


@admin_route(Level.SESSION, methods=POST)
def section_trash(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    content.trash(found)
    return JsonResponse({})


@admin_route(Level.SESSION, methods=POST)
def section_restore(request, section_id):
    found = Section.objects.filter(id=section_id).first()
    if found is None:
        return responses.not_found()
    with transaction.atomic():
        refusal = _refused(content.restore, found)
    return refusal or JsonResponse(_section_summary(found))


@admin_route(Level.SESSION, methods=POST)
def section_publish(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    return JsonResponse({"version": content.publish(found)})


@admin_route(Level.SESSION)
def section_revisions(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    rows = Revision.objects.filter(
        entity=content.REVISION, entity_id=found.id
    ).order_by("-version")
    return _page(
        request,
        rows,
        lambda revision: {
            "version": revision.version,
            "created_at": _when(revision.created_at),
            "title": revision.data["section"].get("title", ""),
            "items": len(revision.data["items"]),
        },
    )


@admin_route(Level.SESSION, methods=POST)
def section_revision_restore(request, section_id, version):
    found = _live_section(section_id)
    if found is None or not content.restore_version(found, version):
        return responses.not_found()
    return JsonResponse(_section_detail(found))


# Items


@admin_route(Level.SESSION, methods=("GET", "POST"))
def section_items(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    if request.method == "GET":
        return _page(request, content.live_items(found), _item)
    body, error = _valid(serializers.ItemBody, request.json)
    if error:
        return error
    shape = content.ITEM_TYPES.get(found.type)
    if shape is None:
        return responses.conflict()
    data, error = _valid(shape, body["data"])
    if error:
        return error
    try:
        item = content.add_item(found, data)
    except content.Refused:
        return responses.conflict()
    return JsonResponse(_item(item), status=201)


@admin_route(Level.SESSION, methods=POST)
def section_items_reorder(request, section_id):
    found = _live_section(section_id)
    if found is None:
        return responses.not_found()
    data, error = _valid(serializers.Order, request.json)
    if error:
        return error
    moved = content.reorder(
        content.live_items(found), data["ids"], "items_reordered", section=str(found.id)
    )
    return JsonResponse({}) if moved else responses.bad_request()


@admin_route(Level.SESSION, methods=READ_EDIT)
def item(request, item_id):
    found = _live_item(item_id)
    if found is None:
        return responses.not_found()
    if request.method == "PATCH":
        body, error = _valid(serializers.ItemBody, request.json)
        if error:
            return error
        data, error = _valid(content.ITEM_TYPES[found.section.type], body["data"])
        if error:
            return error
        content.edit_item(found, data)
    return JsonResponse(_item(found))


@admin_route(Level.SESSION, methods=POST)
def item_visibility(request, item_id):
    found = _live_item(item_id)
    if found is None:
        return responses.not_found()
    data, error = _valid(serializers.Visibility, request.json)
    if error:
        return error
    content.set_visible(found, data["visible"])
    return JsonResponse(_item(found))


@admin_route(Level.SESSION, methods=POST)
def item_trash(request, item_id):
    found = _live_item(item_id)
    if found is None:
        return responses.not_found()
    content.trash(found)
    return JsonResponse({})


@admin_route(Level.SESSION, methods=POST)
def item_restore(request, item_id):
    found = SectionItem.objects.filter(id=item_id).select_related("section").first()
    if found is None:
        return responses.not_found()
    with transaction.atomic():
        refusal = _refused(content.restore, found)
    return refusal or JsonResponse(_item(found))


# Trash


@admin_route(Level.SESSION)
def trash(request):
    return _page(
        request,
        content.trashed(),
        lambda entry: {
            **entry,
            "trashed_at": _when(entry["trashed_at"]),
            "purge_after": _when(content.purge_after(entry["trashed_at"])),
        },
    )
