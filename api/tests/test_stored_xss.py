"""Script payloads in every content field are stored as typed and only ever
returned as JSON. Turning them into inert text on a page is the renderer's job
(web/lib/markdown.tsx); the API must not mangle them or serve them as HTML."""

import pytest

from core import serializers as s
from core.models import Section, SectionItem, SiteSettings
from tests.shapes import ITEM_SHAPES, SECTION_SHAPES, sample

pytestmark = pytest.mark.django_db

PAYLOADS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '"><svg onload=alert(1)>',
    "[x](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    "{{7*7}}${7*7}<%= 7*7 %>",
    "</textarea><script>alert(1)</script>"[:40],
]


def assert_json_only(response):
    assert response["Content-Type"] == "application/json"
    assert response["X-Content-Type-Options"] == "nosniff"


def filled(shape, payload):
    return sample(shape, lambda field: payload[: field.max_length])


@pytest.mark.parametrize("kind", SECTION_SHAPES)
@pytest.mark.parametrize("payload", PAYLOADS)
def test_payload_in_every_section_field_is_stored_as_typed(signed_in, kind, payload):
    section = signed_in.post("/sections", {"type": kind, "title": "T"}).json()
    body = filled(s.SECTION_SHAPES[kind], payload)

    saved = signed_in.patch(f"/sections/{section['id']}", body)
    published = signed_in.post(f"/sections/{section['id']}/publish", {"confirm": True})
    read = signed_in.get(f"/sections/{section['id']}")

    assert saved.status_code == 200, saved.content
    assert published.status_code == 200, published.content
    assert read.json()["draft"] == body
    assert Section.objects.get(id=section["id"]).published["title"] == body["title"]
    for response in (saved, published, read):
        assert_json_only(response)


@pytest.mark.parametrize("kind", ITEM_SHAPES)
@pytest.mark.parametrize("payload", PAYLOADS)
def test_payload_in_every_item_field_is_stored_as_typed(signed_in, kind, payload):
    section = signed_in.post("/sections", {"type": kind, "title": "T"}).json()
    data = filled(s.ITEM_TYPES[kind], payload)

    added = signed_in.post(f"/sections/{section['id']}/items", {"data": data})
    read = signed_in.get(f"/items/{added.json()['id']}")
    listed = signed_in.get(f"/sections/{section['id']}/items")

    assert added.status_code == 201, added.content
    assert read.json()["data"] == data
    assert SectionItem.objects.get(id=added.json()["id"]).draft == data
    for response in (added, read, listed):
        assert_json_only(response)


@pytest.mark.parametrize("payload", PAYLOADS)
def test_payload_in_every_settings_field_is_stored_as_typed(signed_in, payload):
    body = filled(s.Settings, payload)

    saved = signed_in.patch("/settings", body)
    published = signed_in.post("/settings/publish", {"confirm": True})

    assert saved.status_code == 200, saved.content
    assert published.status_code == 200, published.content
    assert signed_in.get("/settings").json()["draft"] == body
    assert SiteSettings.objects.get().published["title"] == body["title"]
    assert_json_only(saved)


SCRIPT_URLS = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http://example.test/",
    "//example.test/",
    "https://",
    "https://user:pass@example.test/",
    "https://example.test/ x",
    "mailto:someone@example.test",
]


@pytest.mark.parametrize("url", SCRIPT_URLS)
def test_link_fields_refuse_anything_but_https(signed_in, url):
    links = signed_in.post("/sections", {"type": "links", "title": "L"}).json()
    projects = signed_in.post("/sections", {"type": "projects", "title": "P"}).json()
    project = sample(s.Project)
    project["links"][0]["url"] = url

    plain = signed_in.post(
        f"/sections/{links['id']}/items", {"data": {"label": "x", "url": url}}
    )
    nested = signed_in.post(f"/sections/{projects['id']}/items", {"data": project})

    assert plain.status_code == 400
    assert nested.status_code == 400
    assert SectionItem.objects.count() == 0
