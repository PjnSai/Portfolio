"""Project slugs: stored on first publish, kept through renames, the trash and
restores, unique with a numeric suffix, and sent in the public site document."""

import json
from pathlib import Path

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import Client

from core import slugs
from core.models import Section, SectionItem

pytestmark = pytest.mark.django_db

VECTORS = json.loads(
    (Path(__file__).parent / "slug_vectors.json").read_text(encoding="utf8")
)
PROJECT = {
    "title": "Task board",
    "summary": "A board.",
    "body": "",
    "status": "live",
    "colour": "blue",
    "tags": [],
    "links": [],
    "fields": [],
    "images": [],
}


def section_with(api, *titles):
    section = api.post("/sections", {"type": "projects", "title": "Work"}).json()
    items = [
        api.post(
            f"/sections/{section['id']}/items", {"data": {**PROJECT, "title": title}}
        ).json()
        for title in titles
    ]
    return section, items


def publish(api, section):
    assert api.post(f"/sections/{section['id']}/publish").status_code == 200


def site_slugs():
    site = Client().get("/api/v1/site").json()
    return [
        (item["data"]["title"], item.get("slug"))
        for section in site["sections"]
        if section["type"] == "projects"
        for item in section["items"]
    ]


@pytest.mark.parametrize(("title", "expected"), VECTORS)
def test_slugify_matches_the_shared_vectors(title, expected):
    assert slugs.slugify(title) == expected


def test_a_project_has_no_slug_until_it_is_first_published(signed_in):
    section, (item,) = section_with(signed_in, "Task board")
    assert item["slug"] is None

    publish(signed_in, section)

    assert SectionItem.objects.get(id=item["id"]).slug == "task-board"
    assert signed_in.get(f"/items/{item['id']}").json()["slug"] == "task-board"
    assert site_slugs() == [("Task board", "task-board")]


def test_renaming_a_published_project_keeps_its_slug(signed_in):
    section, (item,) = section_with(signed_in, "Task board")
    publish(signed_in, section)

    signed_in.patch(f"/items/{item['id']}", {"data": {**PROJECT, "title": "Kanban"}})
    publish(signed_in, section)

    assert site_slugs() == [("Kanban", "task-board")]


def test_a_clash_gets_a_numeric_suffix(signed_in):
    section, _ = section_with(signed_in, "Task board", "Task board", "Page")
    other, _ = section_with(signed_in, "Task board")
    publish(signed_in, section)
    publish(signed_in, other)

    assert [slug for _, slug in site_slugs()] == [
        "task-board",
        "task-board-2",
        "page-2",
        "task-board-3",
    ]


def test_a_hidden_project_gets_its_slug_when_it_is_first_shown(signed_in):
    section, (shown, hidden) = section_with(signed_in, "Task board", "Log parser")
    signed_in.post(f"/items/{hidden['id']}/visibility", {"visible": False})
    publish(signed_in, section)
    assert SectionItem.objects.get(id=hidden["id"]).slug is None

    signed_in.patch(f"/items/{hidden['id']}", {"data": {**PROJECT, "title": "Parser"}})
    signed_in.post(f"/items/{hidden['id']}/visibility", {"visible": True})
    publish(signed_in, section)

    assert site_slugs() == [("Task board", "task-board"), ("Parser", "parser")]


def test_a_trashed_and_restored_project_keeps_its_slug(signed_in):
    section, (item,) = section_with(signed_in, "Task board")
    publish(signed_in, section)
    signed_in.post(f"/items/{item['id']}/trash")
    publish(signed_in, section)

    # A new project with the same title cannot take the trashed one's slug.
    added = signed_in.post(f"/sections/{section['id']}/items", {"data": PROJECT}).json()
    publish(signed_in, section)
    assert SectionItem.objects.get(id=added["id"]).slug == "task-board-2"

    assert signed_in.post(f"/items/{item['id']}/restore").status_code == 200
    publish(signed_in, section)

    assert sorted(slug for _, slug in site_slugs()) == ["task-board", "task-board-2"]
    assert SectionItem.objects.get(id=item["id"]).slug == "task-board"


def test_other_item_types_never_get_a_slug(signed_in):
    section = signed_in.post("/sections", {"type": "links", "title": "Links"}).json()
    item = signed_in.post(
        f"/sections/{section['id']}/items",
        {"data": {"label": "GitHub", "url": "https://github.test/owner"}},
    ).json()
    publish(signed_in, section)

    assert SectionItem.objects.get(id=item["id"]).slug is None
    assert "slug" not in Section.objects.get(id=section["id"]).published["items"][0]


# Migration 0012


def migrate(target):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(target)
    return executor.loader.project_state(target).apps


@pytest.fixture
def before_slugs():
    apps = migrate([("core", "0011_default_palette_a")])
    yield apps
    migrate([("core", "0012_project_slugs")])


def test_0012_gives_every_project_a_slug_and_keeps_live_addresses(before_slugs):
    Section = before_slugs.get_model("core", "Section")
    Item = before_slugs.get_model("core", "SectionItem")
    live = Section.objects.create(type="projects", position=0)
    draft_only = Section.objects.create(type="projects", position=1)
    links = Section.objects.create(type="links", position=2)
    # Published as "Task board" twice; the second is "task-board-2" on the site
    # now, and must stay so although its draft title has changed since.
    a = Item.objects.create(section=live, position=0, draft={**PROJECT})
    b = Item.objects.create(
        section=live, position=1, draft={**PROJECT, "title": "Renamed"}
    )
    hidden = Item.objects.create(
        section=live, position=2, draft={**PROJECT, "title": "Hidden"}
    )
    unpublished = Item.objects.create(section=draft_only, position=0, draft=PROJECT)
    link = Item.objects.create(section=links, position=0, draft={"label": "x"})
    live.published = {
        "type": "projects",
        "title": "Work",
        "items": [
            {"id": str(a.id), "data": PROJECT},
            {"id": str(b.id), "data": PROJECT},
        ],
    }
    live.save()
    # The test runs in one transaction; Postgres will not alter a table with
    # foreign-key checks still queued, so run them now.
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    apps = migrate([("core", "0012_project_slugs")])

    Item = apps.get_model("core", "SectionItem")
    found = {str(i.id): i.slug for i in Item.objects.all()}
    assert found[str(a.id)] == "task-board"
    assert found[str(b.id)] == "task-board-2"
    assert found[str(hidden.id)] == "hidden"
    assert found[str(unpublished.id)] == "task-board-3"
    assert found[str(link.id)] is None
    published = apps.get_model("core", "Section").objects.get(id=live.id).published
    assert [i["slug"] for i in published["items"]] == ["task-board", "task-board-2"]
