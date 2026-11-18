"""Sections and items: add, edit, show and hide, reorder, publish, restore, trash."""

from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from core import content
from core.models import AuditLog, Revision, Section, SectionItem

pytestmark = pytest.mark.django_db

PROJECT = {
    "title": "Ledger",
    "summary": "A small accounting tool.",
    "body": "",
    "status": "in_progress",
    "colour": "orange",
    "tags": [],
    "links": [],
    "fields": [],
    "images": [],
}


def add_section(api, kind="projects", title="Projects"):
    response = api.post("/sections", {"type": kind, "title": title})
    assert response.status_code == 201, response.content
    return response.json()


def add_item(api, section, data=None):
    response = api.post(f"/sections/{section['id']}/items", {"data": data or PROJECT})
    assert response.status_code == 201, response.content
    return response.json()


def events():
    return list(AuditLog.objects.order_by("seq").values_list("event", flat=True))


# Sections


def test_a_new_section_is_a_hidden_draft_until_published(signed_in):
    section = add_section(signed_in)

    assert section["type"] == "projects"
    assert section["draft"] == {"title": "Projects", "body": ""}
    assert section["published_at"] is None
    assert section["unpublished_changes"] is True
    assert Section.objects.get(id=section["id"]).published == {}
    assert "section_added" in events()


def test_sections_are_listed_in_order_and_paged(signed_in):
    for number in range(30):
        add_section(signed_in, "text", f"Text {number}")

    first = signed_in.get("/sections").json()
    second = signed_in.get("/sections", {"page": 2}).json()

    assert first["count"] == 30 and first["pages"] == 2
    assert [s["title"] for s in first["results"]][:2] == ["Text 0", "Text 1"]
    assert len(first["results"]) == content.PAGE_SIZE
    assert len(second["results"]) == 30 - content.PAGE_SIZE


@pytest.mark.parametrize("kind", content.SECTION_TYPES)
def test_every_section_type_can_be_added(signed_in, kind):
    add_section(signed_in, kind, kind.title())


@pytest.mark.parametrize("kind", ["hero", "contact"])
def test_one_of_a_kind_sections_cannot_be_added_twice(signed_in, kind):
    add_section(signed_in, kind, "First")

    response = signed_in.post("/sections", {"type": kind, "title": "Second"})

    assert response.status_code == 409


def test_editing_changes_the_draft_only(signed_in):
    section = add_section(signed_in)
    signed_in.post(f"/sections/{section['id']}/publish")

    response = signed_in.patch(f"/sections/{section['id']}", {"title": "Work"})

    assert response.status_code == 200
    assert response.json()["draft"]["title"] == "Work"
    assert response.json()["unpublished_changes"] is True
    assert Section.objects.get(id=section["id"]).published["title"] == "Projects"


def test_show_and_hide_take_effect_at_once(signed_in):
    section = add_section(signed_in)

    hidden = signed_in.post(f"/sections/{section['id']}/visibility", {"visible": False})
    listed = signed_in.get("/sections").json()["results"][0]

    assert hidden.status_code == 200
    assert listed["visible"] is False
    assert Section.objects.get(id=section["id"]).visible is False
    assert "section_hidden" in events()


def test_sections_can_be_reordered(signed_in):
    ids = [add_section(signed_in, "text", name)["id"] for name in "ABC"]

    response = signed_in.post("/sections/reorder", {"ids": [ids[2], ids[0], ids[1]]})
    titles = [s["title"] for s in signed_in.get("/sections").json()["results"]]

    assert response.status_code == 200
    assert titles == ["C", "A", "B"]


@pytest.mark.parametrize(
    "order",
    [
        lambda ids: ids[:2],
        lambda ids: ids + [ids[0]],
        lambda ids: ids[:2] + ["00000000-0000-4000-8000-000000000000"],
        lambda ids: "not a list",
        lambda ids: ids + [1],
    ],
)
def test_reorder_must_name_every_section_once(signed_in, order):
    ids = [add_section(signed_in, "text", name)["id"] for name in "ABC"]

    response = signed_in.post("/sections/reorder", {"ids": order(ids)})

    assert response.status_code == 400
    titles = [s["title"] for s in signed_in.get("/sections").json()["results"]]
    assert titles == ["A", "B", "C"]


# Items


def test_items_are_added_to_the_draft(signed_in):
    section = add_section(signed_in)

    item = add_item(signed_in, section)
    listed = signed_in.get(f"/sections/{section['id']}/items").json()

    assert item["data"]["title"] == "Ledger"
    assert item["visible"] is True
    assert [i["id"] for i in listed["results"]] == [item["id"]]
    assert SectionItem.objects.get(id=item["id"]).published == {}


@pytest.mark.parametrize("kind", ["hero", "about", "text", "contact"])
def test_sections_without_items_refuse_them(signed_in, kind):
    section = add_section(signed_in, kind, "Only text")

    response = signed_in.post(
        f"/sections/{section['id']}/items", {"data": {"title": "x"}}
    )

    assert response.status_code == 409


def test_items_can_be_edited_hidden_and_reordered(signed_in):
    section = add_section(signed_in)
    a, b = add_item(signed_in, section), add_item(signed_in, section)

    edited = signed_in.patch(
        f"/items/{a['id']}", {"data": {**PROJECT, "title": "Renamed"}}
    )
    hidden = signed_in.post(f"/items/{b['id']}/visibility", {"visible": False})
    moved = signed_in.post(
        f"/sections/{section['id']}/items/reorder", {"ids": [b["id"], a["id"]]}
    )
    listed = signed_in.get(f"/sections/{section['id']}/items").json()["results"]

    assert (edited.status_code, hidden.status_code, moved.status_code) == (200,) * 3
    assert [(i["id"], i["visible"]) for i in listed] == [
        (b["id"], False),
        (a["id"], True),
    ]
    assert listed[1]["data"]["title"] == "Renamed"


def test_item_reorder_must_name_every_item_of_that_section(signed_in):
    section, other = add_section(signed_in), add_section(signed_in, "links", "Links")
    a = add_item(signed_in, section)
    stranger = add_item(signed_in, other, {"label": "Code", "url": "https://x.test"})

    response = signed_in.post(
        f"/sections/{section['id']}/items/reorder", {"ids": [a["id"], stranger["id"]]}
    )

    assert response.status_code == 400


# Publish and version history


def test_publish_makes_the_draft_live_and_keeps_a_version(signed_in):
    section = add_section(signed_in)
    shown = add_item(signed_in, section)
    hidden = add_item(signed_in, section, {**PROJECT, "title": "Secret draft"})
    signed_in.post(f"/items/{hidden['id']}/visibility", {"visible": False})

    response = signed_in.post(f"/sections/{section['id']}/publish")
    stored = Section.objects.get(id=section["id"])

    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert stored.published["title"] == "Projects"
    assert [i["id"] for i in stored.published["items"]] == [shown["id"]]
    assert "Secret draft" not in str(stored.published)
    assert stored.published_at is not None
    assert SectionItem.objects.get(id=shown["id"]).published == PROJECT
    assert (
        signed_in.get(f"/sections/{section['id']}").json()["unpublished_changes"]
        is False
    )
    assert "section_published" in events()


def test_every_publish_adds_a_version(signed_in):
    section = add_section(signed_in)
    for title in ("One", "Two", "Three"):
        signed_in.patch(f"/sections/{section['id']}", {"title": title})
        signed_in.post(f"/sections/{section['id']}/publish")

    versions = signed_in.get(f"/sections/{section['id']}/revisions").json()

    assert [v["version"] for v in versions["results"]] == [3, 2, 1]
    assert versions["count"] == 3


def test_restoring_a_version_brings_back_its_draft(signed_in):
    section = add_section(signed_in)
    kept = add_item(signed_in, section)
    signed_in.post(f"/sections/{section['id']}/publish")
    signed_in.patch(f"/sections/{section['id']}", {"title": "Changed"})
    signed_in.patch(f"/items/{kept['id']}", {"data": {**PROJECT, "title": "Edited"}})
    signed_in.post(f"/items/{kept['id']}/visibility", {"visible": False})
    added_later = add_item(signed_in, section, {**PROJECT, "title": "Later"})

    response = signed_in.post(f"/sections/{section['id']}/revisions/1/restore")
    detail = signed_in.get(f"/sections/{section['id']}").json()
    items = signed_in.get(f"/sections/{section['id']}/items").json()["results"]

    assert response.status_code == 200
    assert detail["draft"]["title"] == "Projects"
    assert detail["unpublished_changes"] is False
    assert [(i["id"], i["visible"], i["data"]) for i in items] == [
        (kept["id"], True, PROJECT)
    ]
    # Nothing is lost: what was added since went to the trash.
    assert SectionItem.objects.get(id=added_later["id"]).trashed_at is not None
    assert "section_version_restored" in events()


def test_restoring_an_unknown_version_is_not_found(signed_in):
    section = add_section(signed_in)

    response = signed_in.post(f"/sections/{section['id']}/revisions/7/restore")

    assert response.status_code == 404


# Trash


def test_trashed_section_leaves_the_list_and_can_be_restored(signed_in):
    section = add_section(signed_in)

    trashed = signed_in.post(f"/sections/{section['id']}/trash")
    listed = signed_in.get("/sections").json()["results"]
    in_trash = signed_in.get("/trash").json()["results"]
    hidden_detail = signed_in.get(f"/sections/{section['id']}")
    restored = signed_in.post(f"/sections/{section['id']}/restore")

    assert trashed.status_code == 200
    assert listed == []
    assert [(t["entity"], t["id"]) for t in in_trash] == [("section", section["id"])]
    assert hidden_detail.status_code == 404
    assert restored.status_code == 200
    assert [s["id"] for s in signed_in.get("/sections").json()["results"]] == [
        section["id"]
    ]


def test_trashed_item_can_be_restored(signed_in):
    section = add_section(signed_in)
    item = add_item(signed_in, section)

    signed_in.post(f"/items/{item['id']}/trash")
    listed = signed_in.get(f"/sections/{section['id']}/items").json()["results"]
    in_trash = signed_in.get("/trash").json()["results"]
    restored = signed_in.post(f"/items/{item['id']}/restore")

    assert listed == []
    assert in_trash[0]["entity"] == "item" and in_trash[0]["label"] == "Ledger"
    assert restored.status_code == 200
    assert signed_in.get(f"/items/{item['id']}").status_code == 200


def test_trashed_things_cannot_be_edited(signed_in):
    section = add_section(signed_in)
    item = add_item(signed_in, section)
    signed_in.post(f"/items/{item['id']}/trash")
    signed_in.post(f"/sections/{section['id']}/trash")

    assert (
        signed_in.patch(f"/sections/{section['id']}", {"title": "x"}).status_code == 404
    )
    assert signed_in.patch(f"/items/{item['id']}", {"data": PROJECT}).status_code == 404
    assert signed_in.post(f"/sections/{section['id']}/publish").status_code == 404


def test_item_in_a_trashed_section_waits_for_the_section(signed_in):
    section = add_section(signed_in)
    item = add_item(signed_in, section)
    signed_in.post(f"/items/{item['id']}/trash")
    signed_in.post(f"/sections/{section['id']}/trash")

    assert signed_in.post(f"/items/{item['id']}/restore").status_code == 409


def test_restore_is_refused_after_thirty_days(signed_in):
    section = add_section(signed_in)
    signed_in.post(f"/sections/{section['id']}/trash")
    Section.objects.filter(id=section["id"]).update(
        trashed_at=timezone.now() - timedelta(days=31)
    )

    assert signed_in.post(f"/sections/{section['id']}/restore").status_code == 409


def test_trash_shows_when_each_entry_goes(signed_in):
    section = add_section(signed_in)
    signed_in.post(f"/sections/{section['id']}/trash")

    entry = signed_in.get("/trash").json()["results"][0]

    assert entry["purge_after"] > entry["trashed_at"]


def test_purge_removes_only_what_has_been_in_the_trash_thirty_days(signed_in):
    old, recent, live = (
        add_section(signed_in, "text", n) for n in ("Old", "New", "Live")
    )
    item = add_item(signed_in, add_section(signed_in))
    signed_in.post(f"/sections/{old['id']}/publish")
    for target in (old, recent):
        signed_in.post(f"/sections/{target['id']}/trash")
    signed_in.post(f"/items/{item['id']}/trash")
    long_ago = timezone.now() - timedelta(days=31)
    Section.objects.filter(id=old["id"]).update(trashed_at=long_ago)
    SectionItem.objects.filter(id=item["id"]).update(trashed_at=long_ago)

    call_command("purge_trash")

    remaining = set(Section.objects.values_list("id", flat=True))
    assert {str(r) for r in remaining} >= {recent["id"], live["id"]}
    assert old["id"] not in {str(r) for r in remaining}
    assert not SectionItem.objects.filter(id=item["id"]).exists()
    assert not Revision.objects.filter(entity_id=old["id"]).exists()
    last = AuditLog.objects.order_by("-seq").first()
    assert (last.event, last.actor) == ("trash_purged", "system")
    assert last.detail == {"sections": 1, "items": 1, "media": 0, "palettes": 0}


# Limits


def test_number_of_sections_is_capped(signed_in, monkeypatch):
    monkeypatch.setattr(content, "MAX_SECTIONS", 2)
    add_section(signed_in, "text", "A")
    add_section(signed_in, "text", "B")

    assert (
        signed_in.post("/sections", {"type": "text", "title": "C"}).status_code == 409
    )


def test_number_of_items_is_capped(signed_in, monkeypatch):
    monkeypatch.setattr(content, "MAX_ITEMS", 1)
    section = add_section(signed_in)
    add_item(signed_in, section)

    response = signed_in.post(f"/sections/{section['id']}/items", {"data": PROJECT})

    assert response.status_code == 409


def test_unknown_ids_are_not_found(signed_in):
    missing = "00000000-0000-4000-8000-000000000000"

    assert signed_in.get(f"/sections/{missing}").status_code == 404
    assert signed_in.get(f"/items/{missing}").status_code == 404
    assert signed_in.post(f"/items/{missing}/trash").status_code == 404


def test_audit_entries_hold_ids_not_content(signed_in):
    section = add_section(signed_in, "text", "Private wording")
    signed_in.patch(f"/sections/{section['id']}", {"body": "Very private body"})

    logged = str(list(AuditLog.objects.values_list("detail", flat=True)))

    assert "Private wording" not in logged
    assert "Very private body" not in logged
    assert section["id"] in logged
