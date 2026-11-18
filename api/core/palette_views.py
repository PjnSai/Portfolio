"""Admin routes for colour palettes. Changes stay in the draft until the site
settings are published, which rebuilds the site."""

from django.db import transaction
from django.http import JsonResponse

from core import content, palettes, responses, serializers
from core.authz import Level, admin_route
from core.content_views import _valid
from core.models import Palette

POST = ("POST",)


def _refusal(error):
    return responses.conflict(error.args[0] if error.args else None)


@admin_route(Level.SESSION, methods=("GET", "POST"))
def palette_list(request):
    if request.method == "GET":
        row = content.site_settings()
        choice = {key: row.draft.get(key) for key in content.PALETTE_KEYS}
        return JsonResponse(
            {
                "palettes": [palettes.describe(p) for p in palettes.live()],
                "max_custom": content.MAX_CUSTOM_PALETTES,
                **choice,
            }
        )
    data, error = _valid(serializers.PaletteBody, request.json)
    if error:
        return error
    try:
        palette = palettes.add(data)
    except content.Refused as refused:
        return _refusal(refused)
    return JsonResponse(palettes.describe(palette), status=201)


@admin_route(Level.SESSION, methods=POST)
def palette_use(request):
    row = content.site_settings()
    choice, error = _valid(serializers.PaletteChoice, request.json)
    if error:
        return error
    # The whole draft is checked again, as a settings edit would be.
    _, error = _valid(serializers.Settings, {**row.draft, **choice})
    if error:
        return error
    row = palettes.choose(choice)
    return JsonResponse({key: row.draft[key] for key in content.PALETTE_KEYS})


@admin_route(Level.SESSION, methods=("GET", "PATCH"))
def palette(request, palette_id):
    found = palettes.find(palette_id)
    if found is None:
        return responses.not_found()
    if request.method == "PATCH":
        if found.kind == Palette.Kind.PRESET:
            return responses.conflict("preset")
        current = {"name": found.name, "light": found.light, "dark": found.dark}
        data, error = _valid(serializers.PaletteBody, {**current, **request.json})
        if error:
            return error
        palettes.edit(found, data)
    return JsonResponse(palettes.describe(found))


@admin_route(Level.SESSION, methods=POST)
def palette_duplicate(request, palette_id):
    found = palettes.find(palette_id)
    if found is None:
        return responses.not_found()
    data, error = _valid(serializers.Duplicate, request.json)
    if error:
        return error
    try:
        copy = palettes.duplicate(found, data.get("name"))
    except content.Refused as refused:
        return _refusal(refused)
    return JsonResponse(palettes.describe(copy), status=201)


@admin_route(Level.SESSION, methods=POST)
def palette_trash(request, palette_id):
    found = palettes.find(palette_id)
    if found is None:
        return responses.not_found()
    try:
        palettes.trash(found)
    except content.Refused as refused:
        return _refusal(refused)
    return JsonResponse({})


@admin_route(Level.SESSION, methods=POST)
def palette_restore(request, palette_id):
    found = Palette.objects.filter(id=palette_id).first()
    if found is None:
        return responses.not_found()
    try:
        with transaction.atomic():
            content.restore(found)
    except content.Refused as refused:
        return _refusal(refused)
    return JsonResponse(palettes.describe(found))
