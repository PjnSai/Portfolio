"""Preset E's light primary goes back to the spec orange, now that the primary
has no contrast rule against the page, and preset A becomes the default in the
draft settings. The owner publishes to put it live."""

from django.db import migrations

PRESET_A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"
PRESET_E = "b399fb8f-5de4-462d-98f5-a81bf8046a6f"


def _primary(apps, colour):
    Palette = apps.get_model("core", "Palette")
    found = Palette.objects.filter(id=PRESET_E).first()
    if found is not None:
        found.light = {**found.light, "primary": colour}
        found.save(update_fields=["light"])


def _make_default(apps, palette_id):
    SiteSettings = apps.get_model("core", "SiteSettings")
    for row in SiteSettings.objects.all():
        if not row.draft:
            continue
        enabled = row.draft.get("enabled_palette_ids", [])
        enabled = [i for i in enabled if i != palette_id]
        row.draft = {
            **row.draft,
            "default_palette_id": palette_id,
            "enabled_palette_ids": [palette_id, *enabled],
        }
        row.save(update_fields=["draft"])


def forwards(apps, schema_editor):
    _primary(apps, "#FF5A1F")
    _make_default(apps, PRESET_A)


def backwards(apps, schema_editor):
    _primary(apps, "#E8551C")
    _make_default(apps, PRESET_E)


class Migration(migrations.Migration):
    dependencies = [("core", "0010_palette_data")]

    operations = [migrations.RunPython(forwards, backwards)]
