"""Colour palettes. Presets are made by a migration and never change; the owner
duplicates one to make a custom palette (at most 12). Palette rows are drafts:
visitors get the copy taken when the site settings are published."""

from django.db import transaction
from django.utils import timezone

from core import audit, content
from core.content import Refused
from core.models import Owner, Palette, SiteSettings

PRESET = Palette.Kind.PRESET


def live():
    return Palette.objects.filter(trashed_at=None)


def find(palette_id):
    return live().filter(id=palette_id).first()


def describe(palette):
    return {
        **content.palette_copy(palette),
        "kind": palette.kind,
        "created_at": palette.created_at.isoformat(),
        "updated_at": palette.updated_at.isoformat(),
    }


def add(data, event="palette_added", **detail):
    with transaction.atomic():
        # The owner row lock makes two adds take turns, so the cap holds.
        Owner.objects.select_for_update().get()
        if content.custom_palettes().count() >= content.MAX_CUSTOM_PALETTES:
            raise Refused("palette_limit")
        palette = Palette.objects.create(
            name=data["name"],
            kind=Palette.Kind.CUSTOM,
            light=data["light"],
            dark=data["dark"],
        )
        audit.record(event, palette=str(palette.id), **detail)
    return palette


def duplicate(palette, name=None):
    copy_name = name or f"{palette.name} copy"[:60]
    data = {"name": copy_name, "light": palette.light, "dark": palette.dark}
    return add(data, "palette_duplicated", source=str(palette.id))


def edit(palette, data):
    if palette.kind == PRESET:
        raise Refused("preset")
    palette.name = data["name"]
    palette.light = data["light"]
    palette.dark = data["dark"]
    palette.save(update_fields=["name", "light", "dark", "updated_at"])
    audit.record("palette_changed", palette=str(palette.id))


def trash(palette):
    """To the trash, and off the draft list visitors may use. The default, in
    the draft or on the live site, must be changed first."""
    if palette.kind == PRESET:
        raise Refused("preset")
    palette_id = str(palette.id)
    with transaction.atomic():
        row = SiteSettings.objects.select_for_update().get(
            id=content.site_settings().id
        )
        defaults = {
            row.draft.get("default_palette_id"),
            row.published.get("default_palette_id"),
        }
        if palette_id in defaults:
            raise Refused("default")
        enabled = row.draft.get("enabled_palette_ids", [])
        if palette_id in enabled:
            row.draft = {
                **row.draft,
                "enabled_palette_ids": [i for i in enabled if i != palette_id],
            }
            row.save(update_fields=["draft", "updated_at"])
        palette.trashed_at = timezone.now()
        palette.save(update_fields=["trashed_at", "updated_at"])
        audit.record("palette_trashed", palette=palette_id)


def choose(data):
    """Set the mode, the default and the enabled list in the draft settings."""
    with transaction.atomic():
        row = SiteSettings.objects.select_for_update().get(
            id=content.site_settings().id
        )
        row.draft = {**row.draft, **data}
        row.save(update_fields=["draft", "updated_at"])
        audit.record(
            "palettes_chosen",
            mode=data["palette_mode"],
            default=data["default_palette_id"],
            enabled=len(data["enabled_palette_ids"]),
        )
    return row
