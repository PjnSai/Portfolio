"""Every project gets a stored slug, so a later rename keeps its address.

Projects on the live site come first, in the order the site lists them, and
take the slug the site already gives them from their published title. The
rest (hidden, unpublished or in the trash) follow, from their draft title.
A clash gets -2, -3 and so on. The published copy of each projects section
then carries its items' slugs.

The slug rules are copied here, not imported, so later changes to core.slugs
cannot change what this migration did.
"""

import re
import unicodedata

from django.db import migrations, models

_MARKS = re.compile("[̀-ͯ]")
_OTHER = re.compile(r"[^a-z0-9]+")
RESERVED = {"page"}


def _slugify(text):
    plain = _MARKS.sub("", unicodedata.normalize("NFKD", text or "")).lower()
    slug = _OTHER.sub("-", plain).strip("-")[:60].rstrip("-")
    return slug or "section"


def _unique(title, taken):
    base = _slugify(title)
    slug, n = base, 2
    while slug in taken or slug in RESERVED:
        slug, n = f"{base}-{n}", n + 1
    return slug


def forwards(apps, schema_editor):
    Section = apps.get_model("core", "Section")
    projects = Section.objects.filter(type="projects").order_by(
        "position", "created_at"
    )
    taken = set()

    def give(item, title):
        item.slug = _unique(title, taken)
        taken.add(item.slug)
        item.save(update_fields=["slug"])

    live = [s for s in projects if s.trashed_at is None and s.visible and s.published]
    for section in live:
        rows = {str(item.id): item for item in section.items.all()}
        for entry in section.published.get("items", []):
            item = rows.get(entry.get("id"))
            if item is not None and item.slug is None:
                give(item, entry.get("data", {}).get("title", ""))

    for section in projects:
        for item in section.items.filter(slug=None).order_by("position", "created_at"):
            give(item, item.draft.get("title", ""))

    for section in projects.exclude(published={}):
        slugs = dict(section.items.exclude(slug=None).values_list("id", "slug"))
        slugs = {str(key): value for key, value in slugs.items()}
        items = section.published.get("items", [])
        for entry in items:
            if entry.get("id") in slugs:
                entry["slug"] = slugs[entry["id"]]
        section.published = {**section.published, "items": items}
        section.save(update_fields=["published"])


def backwards(apps, schema_editor):
    Section = apps.get_model("core", "Section")
    for section in Section.objects.filter(type="projects").exclude(published={}):
        items = [
            {key: value for key, value in entry.items() if key != "slug"}
            for entry in section.published.get("items", [])
        ]
        section.published = {**section.published, "items": items}
        section.save(update_fields=["published"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0011_default_palette_a"),
    ]

    operations = [
        migrations.AddField(
            model_name="sectionitem",
            name="slug",
            field=models.CharField(blank=True, max_length=80, null=True, unique=True),
        ),
        migrations.RunPython(forwards, backwards),
    ]
