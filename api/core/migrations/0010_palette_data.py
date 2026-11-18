"""Seed the five preset palettes and move the phase 2B theme into palettes.

The data is written out here rather than imported, so later code changes cannot
change what this migration did."""

from datetime import timedelta

from django.db import migrations
from django.utils import timezone

WHITE = "#FFFFFF"
DEFAULT_ID = "b399fb8f-5de4-462d-98f5-a81bf8046a6f"
KEYS = ("palette_mode", "default_palette_id", "enabled_palette_ids")


def slots(bg, ink, surface, primary, on_primary, *accents):
    found = {
        "bg": bg,
        "ink": ink,
        "surface": surface,
        "primary": primary,
        "on_primary": on_primary,
    }
    for n in range(4):
        found[f"accent_{n + 1}"] = accents[2 * n]
        found[f"on_accent_{n + 1}"] = accents[2 * n + 1]
    return found


# fmt: off
PRESETS = (
    ("0c63ed98-cf1f-4c4d-945f-8725c81ab5b4", "Ink and signal red",
     slots("#F4F2EE", "#111111", WHITE, "#D7261E", WHITE,
           "#111111", "#F4F2EE", "#F2C230", "#111111",
           "#8A8F98", "#111111", "#1F4E9C", WHITE),
     slots("#121212", "#F4F2EE", "#1E1E1E", "#FF4B3E", "#121212",
           "#F4F2EE", "#121212", "#F2C230", "#121212",
           "#8A8F98", "#121212", "#6E9BE8", "#121212")),
    ("bf7b0ec6-833c-4f4c-be66-03ce086e298a", "Forest green and ink",
     slots("#EEF1EA", "#14180F", WHITE, "#1F5A36", WHITE,
           "#14180F", "#EEF1EA", "#C9D66B", "#14180F",
           "#E3B23C", "#14180F", "#6B8F71", "#14180F"),
     slots("#0F1410", "#EEF1EA", "#1A221B", "#5FB57E", "#0F1410",
           "#EEF1EA", "#0F1410", "#C9D66B", "#0F1410",
           "#E3B23C", "#0F1410", "#8FB596", "#0F1410")),
    ("f99b8d9e-fcd4-48cd-8a28-6d9379eae11d", "Oxblood and stone",
     slots("#EDE8E1", "#1C1414", "#F7F4EF", "#6E1423", WHITE,
           "#A89F91", "#1C1414", "#3B4A5A", WHITE,
           "#C98B6B", "#1C1414", "#1C1414", "#EDE8E1"),
     slots("#171213", "#EDE8E1", "#231C1D", "#D0566A", "#171213",
           "#A89F91", "#171213", "#8FA3B8", "#171213",
           "#C98B6B", "#171213", "#EDE8E1", "#171213")),
    ("278c9728-1a8b-4f09-bec6-dbae84b35ed6", "Graphite and signal green",
     slots("#F1F2F0", "#1E2124", WHITE, "#0B7A3B", WHITE,
           "#1E2124", WHITE, "#3DDC84", "#1E2124",
           "#5A6169", WHITE, "#D9DCD6", "#1E2124"),
     slots("#16181A", "#F1F2F0", "#212427", "#3DDC84", "#16181A",
           "#F1F2F0", "#16181A", "#7CE3A6", "#16181A",
           "#9AA3AD", "#16181A", "#5A6169", WHITE)),
    # The original. The light primary is #E8551C, not #FF5A1F: that orange is
    # 2.63:1 on the cream, below the 3:1 a primary colour needs.
    (DEFAULT_ID, "Original",
     slots("#F3EBDD", "#17140F", "#FBF6EE", "#E8551C", "#17140F",
           "#2B57C9", WHITE, "#F2A6C6", "#17140F",
           "#F2B835", "#17140F", "#5E621C", WHITE),
     slots("#17140F", "#F3EBDD", "#24201A", "#FF5A1F", "#17140F",
           "#6E93F0", "#17140F", "#F2A6C6", "#17140F",
           "#F2B835", "#17140F", "#A9AE4A", "#17140F")),
)
# fmt: on

# The 2B default theme. A theme still equal to it was never chosen by the owner,
# so it becomes the Original preset rather than a custom palette.
OLD_DEFAULT = {
    "light": {
        "background": "#f5efe3",
        "ink": "#161412",
        "accent": "#e2531b",
        "on_accent": "#161412",
    },
    "dark": {
        "background": "#161412",
        "ink": "#f5efe3",
        "accent": "#f06a35",
        "on_accent": "#161412",
    },
}


def _from_theme(theme, mode, original):
    """2B had four tokens. The surface is the background and the accents come
    from the Original preset, so every pair that passed before still passes."""
    tokens = {key: value.upper() for key, value in theme[mode].items()}
    return {
        **original[mode],
        "bg": tokens["background"],
        "ink": tokens["ink"],
        "surface": tokens["background"],
        "primary": tokens["accent"],
        "on_primary": tokens["on_accent"],
    }


def _copy(palette):
    return {
        "id": str(palette.id),
        "name": palette.name,
        "light": palette.light,
        "dark": palette.dark,
    }


def forwards(apps, schema_editor):
    Palette = apps.get_model("core", "Palette")
    SiteSettings = apps.get_model("core", "SiteSettings")
    start = timezone.now()
    for order, (palette_id, name, light, dark) in enumerate(PRESETS):
        Palette.objects.create(
            id=palette_id,
            name=name,
            kind="preset",
            light=light,
            dark=dark,
            created_at=start + timedelta(seconds=order),
        )
    default = Palette.objects.get(id=DEFAULT_ID)
    original = {"light": default.light, "dark": default.dark}
    made = {}

    def palette_for(theme, name):
        if not isinstance(theme, dict) or theme == OLD_DEFAULT:
            return default
        key = repr(sorted((mode, sorted(theme[mode].items())) for mode in theme))
        if key not in made:
            made[key] = Palette.objects.create(
                name=name,
                kind="custom",
                light=_from_theme(theme, "light", original),
                dark=_from_theme(theme, "dark", original),
            )
        return made[key]

    for row in SiteSettings.objects.all():
        draft = dict(row.draft)
        if draft:
            chosen = palette_for(draft.pop("theme", None), "Theme")
            row.draft = {**draft, **_choice(chosen)}
        published = dict(row.published)
        if published:
            chosen = palette_for(published.pop("theme", None), "Theme (published)")
            row.published = {
                **published,
                **_choice(chosen),
                "palettes": [_copy(chosen)],
            }
        row.save(update_fields=["draft", "published"])


def _choice(palette):
    return {
        "palette_mode": "fixed",
        "default_palette_id": str(palette.id),
        "enabled_palette_ids": [str(palette.id)],
    }


def _theme(palette):
    def mode(colours):
        return {
            "background": colours["bg"].lower(),
            "ink": colours["ink"].lower(),
            "accent": colours["primary"].lower(),
            "on_accent": colours["on_primary"].lower(),
        }

    return {"light": mode(palette["light"]), "dark": mode(palette["dark"])}


def backwards(apps, schema_editor):
    Palette = apps.get_model("core", "Palette")
    SiteSettings = apps.get_model("core", "SiteSettings")
    for row in SiteSettings.objects.all():
        if row.draft:
            found = Palette.objects.filter(
                id=row.draft.get("default_palette_id")
            ).first()
            theme = _theme(_copy(found)) if found else OLD_DEFAULT
            draft = {k: v for k, v in row.draft.items() if k not in KEYS}
            row.draft = {**draft, "theme": theme}
        if row.published:
            live = {p["id"]: p for p in row.published.get("palettes", [])}
            chosen = live.get(row.published.get("default_palette_id"))
            theme = _theme(chosen) if chosen else OLD_DEFAULT
            published = {
                k: v for k, v in row.published.items() if k not in (*KEYS, "palettes")
            }
            row.published = {**published, "theme": theme}
        row.save(update_fields=["draft", "published"])
    Palette.objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [("core", "0009_palettes")]

    operations = [migrations.RunPython(forwards, backwards)]
