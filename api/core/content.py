"""Sections and their items: drafts, publishing, version history and the trash.

What takes effect at once: the order of sections, whether a section is shown,
and moving a section to the trash. Everything inside a section (its title and
text, its items, their order and whether each is shown) is a draft until the
section is published. Publishing keeps a numbered version that can be restored.
"""

import copy
from datetime import timedelta

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from core import audit, pages, privacy, serializers, theme
from core.models import Owner, Revision, Section, SectionItem, SiteSettings

PAGE_SIZE = pages.PAGE_SIZE
SECTION_TYPES = serializers.SECTION_TYPES
ITEM_TYPES = serializers.ITEM_TYPES

TRASH_DAYS = 30
ONE_OF_A_KIND = {"hero", "contact"}
MAX_SECTIONS = 40
MAX_ITEMS = 200
REVISION = "section"
LABEL_KEYS = ("title", "name", "label", "organisation", "institution", "alt")


class Refused(Exception):
    """The request is valid but not possible in the current state."""


def live_sections():
    return Section.objects.filter(trashed_at=None).order_by("position", "created_at")


def live_items(section):
    return section.items.filter(trashed_at=None).order_by("position", "created_at")


def holds_items(section):
    return section.type in ITEM_TYPES


def purge_after(trashed_at):
    return trashed_at + timedelta(days=TRASH_DAYS)


def item_label(item):
    return data_label(item.draft)


def data_label(data):
    for key in LABEL_KEYS:
        if data.get(key):
            return data[key]
    return "Untitled"


# Draft state and publishing


def draft_state(section):
    """Everything a version keeps: the section's draft and its live items."""
    return {
        "section": dict(section.draft),
        "items": [
            {"id": str(item.id), "visible": item.visible, "data": item.draft}
            for item in live_items(section)
        ],
    }


def latest_revision(section):
    return (
        Revision.objects.filter(entity=REVISION, entity_id=section.id)
        .order_by("-version")
        .first()
    )


def unpublished_changes(section):
    latest = latest_revision(section)
    return latest is None or latest.data != draft_state(section)


def publish_warnings(section):
    """Contact details in what Publish would put on the site."""
    state = draft_state(section)
    found = privacy.scan(state["section"])
    for entry in state["items"]:
        if entry["visible"]:
            found += privacy.scan(entry["data"], f"{data_label(entry['data'])}:")
    return found


def publish(section):
    with transaction.atomic():
        section = Section.objects.select_for_update().get(id=section.id)
        state = draft_state(section)
        version = (
            Revision.objects.filter(entity=REVISION, entity_id=section.id).aggregate(
                highest=Max("version")
            )["highest"]
            or 0
        ) + 1
        Revision.objects.create(
            entity=REVISION, entity_id=section.id, version=version, data=state
        )
        shown = [entry for entry in state["items"] if entry["visible"]]
        section.published = {
            "type": section.type,
            **state["section"],
            "items": [{"id": e["id"], "data": e["data"]} for e in shown],
        }
        section.published_at = timezone.now()
        section.save(update_fields=["published", "published_at", "updated_at"])
        shown_ids = {entry["id"] for entry in shown}
        for item in section.items.all():
            item.published = item.draft if str(item.id) in shown_ids else {}
            item.save(update_fields=["published", "updated_at"])
        audit.record("section_published", section=str(section.id), version=version)
    return version


def restore_version(section, version):
    """Put a version back as the draft. Items added since go to the trash."""
    revision = Revision.objects.filter(
        entity=REVISION, entity_id=section.id, version=version
    ).first()
    if revision is None:
        return False
    now = timezone.now()
    with transaction.atomic():
        section.draft = revision.data["section"]
        section.save(update_fields=["draft", "updated_at"])
        kept = []
        for position, entry in enumerate(revision.data["items"]):
            item = section.items.filter(id=entry["id"]).first()
            if item is None:
                continue  # Deleted for good since; nothing to bring back.
            item.draft = entry["data"]
            item.visible = entry["visible"]
            item.position = position
            item.trashed_at = None
            item.save()
            kept.append(item.id)
        live_items(section).exclude(id__in=kept).update(trashed_at=now)
        audit.record(
            "section_version_restored", section=str(section.id), version=version
        )
    return True


# Sections


def add_section(kind, title):
    with transaction.atomic():
        # The owner row lock makes two adds take turns, so the caps and the
        # one-of-a-kind rule cannot be raced.
        Owner.objects.select_for_update().get()
        if Section.objects.count() >= MAX_SECTIONS:
            raise Refused
        if kind in ONE_OF_A_KIND and live_sections().filter(type=kind).exists():
            raise Refused
        highest = Section.objects.aggregate(highest=Max("position"))["highest"]
        section = Section.objects.create(
            type=kind,
            position=0 if highest is None else highest + 1,
            draft={"title": title, "body": ""},
        )
        audit.record("section_added", section=str(section.id), type=kind)
    return section


def edit_section(section, draft):
    section.draft = draft
    section.save(update_fields=["draft", "updated_at"])
    audit.record("section_changed", section=str(section.id))


def set_visible(target, visible):
    target.visible = visible
    target.save(update_fields=["visible", "updated_at"])
    entity = "section" if isinstance(target, Section) else "item"
    audit.record(
        f"{entity}_{'shown' if visible else 'hidden'}", **{entity: str(target.id)}
    )


def reorder(rows, ids, event, **detail):
    """Give rows the order of ids, which must name each of them exactly once."""
    with transaction.atomic():
        current = {str(row.id): row for row in rows.select_for_update()}
        if len(ids) != len(current) or set(ids) != set(current):
            return False
        for position, row_id in enumerate(ids):
            row = current[row_id]
            if row.position != position:
                row.position = position
                row.save(update_fields=["position", "updated_at"])
        audit.record(event, **detail)
    return True


def trash(target):
    target.trashed_at = timezone.now()
    target.save(update_fields=["trashed_at", "updated_at"])
    entity = "section" if isinstance(target, Section) else "item"
    audit.record(f"{entity}_trashed", **{entity: str(target.id)})


def restore(target):
    """Take something out of the trash, within 30 days."""
    now = timezone.now()
    if target.trashed_at is None or now > purge_after(target.trashed_at):
        raise Refused
    if isinstance(target, Section):
        if (
            target.type in ONE_OF_A_KIND
            and live_sections().filter(type=target.type).exists()
        ):
            raise Refused
        entity = "section"
    else:
        if target.section.trashed_at is not None:
            raise Refused
        entity = "item"
    target.trashed_at = None
    target.save(update_fields=["trashed_at", "updated_at"])
    audit.record(f"{entity}_restored", **{entity: str(target.id)})


# Items


def add_item(section, data):
    with transaction.atomic():
        Owner.objects.select_for_update().get()
        if not holds_items(section) or section.items.count() >= MAX_ITEMS:
            raise Refused
        highest = section.items.aggregate(highest=Max("position"))["highest"]
        item = SectionItem.objects.create(
            section=section,
            position=0 if highest is None else highest + 1,
            draft=data,
        )
        audit.record("item_added", section=str(section.id), item=str(item.id))
    return item


def edit_item(item, data):
    item.draft = data
    item.save(update_fields=["draft", "updated_at"])
    audit.record("item_changed", item=str(item.id))


# Trash listing and clearing


def trashed():
    """Everything in the trash, most recently trashed first."""
    entries = [
        {
            "entity": "section",
            "id": str(section.id),
            "label": section.draft.get("title") or "Untitled",
            "type": section.type,
            "trashed_at": section.trashed_at,
        }
        for section in Section.objects.exclude(trashed_at=None)
    ] + [
        {
            "entity": "item",
            "id": str(item.id),
            "label": item_label(item),
            "type": item.section.type,
            "trashed_at": item.trashed_at,
        }
        for item in SectionItem.objects.exclude(trashed_at=None).select_related(
            "section"
        )
    ]
    entries.sort(key=lambda entry: entry["trashed_at"], reverse=True)
    return entries


def delete_for_good(entity, target_id):
    """Remove a trashed section or item and its history. False if not trashed."""
    model = Section if entity == "section" else SectionItem
    rows = model.objects.filter(id=target_id).exclude(trashed_at=None)
    if not rows.exists():
        return False
    if entity == "section":
        Revision.objects.filter(entity=REVISION, entity_id=target_id).delete()
    rows.delete()
    return True


def purge_trash():
    """Delete what has been in the trash for more than 30 days."""
    cutoff = timezone.now() - timedelta(days=TRASH_DAYS)
    with transaction.atomic():
        old_items = SectionItem.objects.filter(trashed_at__lt=cutoff)
        old_sections = Section.objects.filter(trashed_at__lt=cutoff)
        old_ids = list(old_sections.values_list("id", flat=True))
        items = old_items.delete()[1].get("core.SectionItem", 0)
        Revision.objects.filter(entity=REVISION, entity_id__in=old_ids).delete()
        sections = old_sections.delete()[1].get("core.Section", 0)
        audit.record("trash_purged", actor="system", sections=sections, items=items)
    return {"sections": sections, "items": items}


# Site settings: one row, drafted and published like a section.

SETTINGS = "settings"
DEFAULT_SETTINGS = {
    "title": "Pujan Shahi",
    "description": "TODO: one-line description of the site",
    "contact_form": True,
    "showcase_layout": "ring",
    "layout_switcher": False,
    "theme": theme.DEFAULT,
}


def site_settings():
    row = SiteSettings.objects.first()
    if row is not None:
        return row
    with transaction.atomic():
        Owner.objects.select_for_update().get()
        return SiteSettings.objects.first() or SiteSettings.objects.create(
            draft=copy.deepcopy(DEFAULT_SETTINGS)
        )


def settings_unpublished(row):
    latest = (
        Revision.objects.filter(entity=SETTINGS, entity_id=row.id)
        .order_by("-version")
        .first()
    )
    return latest is None or latest.data != row.draft


def edit_settings(row, draft):
    row.draft = draft
    row.save(update_fields=["draft", "updated_at"])
    audit.record("settings_changed")


def publish_settings(row):
    with transaction.atomic():
        row = SiteSettings.objects.select_for_update().get(id=row.id)
        version = (
            Revision.objects.filter(entity=SETTINGS, entity_id=row.id).aggregate(
                highest=Max("version")
            )["highest"]
            or 0
        ) + 1
        Revision.objects.create(
            entity=SETTINGS, entity_id=row.id, version=version, data=row.draft
        )
        row.published = row.draft
        row.published_at = timezone.now()
        row.save(update_fields=["published", "published_at", "updated_at"])
        audit.record("settings_published", version=version)
    return version
