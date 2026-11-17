"""Section drafts per type, the richer item shapes and site settings."""

import pytest

from core import serializers as s
from core import theme
from core.models import Revision, Section, SiteSettings
from tests.shapes import sample

pytestmark = pytest.mark.django_db

PROJECT = {
    "title": "Ledger",
    "summary": "A small budgeting tool.",
    "body": "Built the **API** myself.",
    "status": "local",
    "created": "2024-03",
    "category": "Web",
    "colour": "blue",
    "tags": ["Python", "Django"],
    "links": [
        {"kind": "repository", "label": "Code", "url": "https://github.test/o/r"}
    ],
    "fields": [{"label": "What I built", "value": "The API and the tests"}],
    "images": [
        {"media": None, "alt": "Dashboard", "caption": ""},
        {"media": None, "alt": "Settings page", "caption": "Dark theme"},
    ],
}


def section_of(api, kind, title="T"):
    return api.post("/sections", {"type": kind, "title": title}).json()["id"]


def test_a_full_project_is_kept_as_sent(signed_in):
    section = section_of(signed_in, "projects")

    added = signed_in.post(f"/sections/{section}/items", {"data": PROJECT})

    assert added.status_code == 201, added.content
    assert added.json()["data"] == PROJECT


def test_a_minimal_project_gets_defaults(signed_in):
    section = section_of(signed_in, "projects")

    data = signed_in.post(
        f"/sections/{section}/items", {"data": {"title": "Ledger"}}
    ).json()["data"]

    assert data["status"] == "in_progress"
    assert data["colour"] == "orange"
    assert data["tags"] == []
    assert data["links"] == []
    assert data["images"] == []


def test_a_project_in_progress_needs_no_creation_date(signed_in):
    section = section_of(signed_in, "projects")
    body = {**PROJECT, "status": "in_progress", "created": ""}

    assert (
        signed_in.post(f"/sections/{section}/items", {"data": body}).status_code == 201
    )


def test_experience_and_education_take_tags_and_grade(signed_in):
    jobs = section_of(signed_in, "experience")
    study = section_of(signed_in, "education")

    job = signed_in.post(
        f"/sections/{jobs}/items",
        {"data": {**sample(s.Experience), "tags": ["Python"]}},
    )
    course = signed_in.post(
        f"/sections/{study}/items",
        {"data": {**sample(s.Education), "grade": "TODO: grade"}},
    )

    assert job.status_code == 201, job.content
    assert course.status_code == 201, course.content


def test_hero_fields(signed_in):
    section = section_of(signed_in, "hero")
    body = {
        "name": "Pujan Shahi",
        "role": "TODO: role title",
        "body": "TODO: short summary",
        "availability": "TODO: availability",
    }

    response = signed_in.patch(f"/sections/{section}", body)

    assert response.status_code == 200, response.content
    assert response.json()["draft"] == {"title": "T", **body}


def test_about_takes_a_location_and_a_photo_slot(signed_in):
    section = section_of(signed_in, "about")
    body = {"location": "TODO: city", "photo": {"media": None, "alt": "Portrait"}}

    response = signed_in.patch(f"/sections/{section}", body)

    assert response.status_code == 200, response.content
    assert response.json()["draft"]["photo"] == {
        "media": None,
        "alt": "Portrait",
        "caption": "",
    }


@pytest.mark.parametrize(
    ("kind", "field"),
    [("text", "name"), ("projects", "location"), ("hero", "photo"), ("about", "role")],
)
def test_section_fields_belong_to_their_type(signed_in, kind, field):
    section = section_of(signed_in, kind)

    response = signed_in.patch(f"/sections/{section}", {field: "x"})

    assert response.status_code == 400
    assert field not in Section.objects.get(id=section).draft


def test_a_section_edit_keeps_fields_it_does_not_send(signed_in):
    section = section_of(signed_in, "hero")
    signed_in.patch(f"/sections/{section}", {"name": "Pujan Shahi"})

    signed_in.patch(f"/sections/{section}", {"role": "TODO: role"})

    draft = Section.objects.get(id=section).draft
    assert draft["name"] == "Pujan Shahi"
    assert draft["role"] == "TODO: role"


# Settings


def test_settings_start_from_defaults(signed_in):
    response = signed_in.get("/settings")

    assert response.status_code == 200
    body = response.json()
    assert body["draft"]["theme"] == theme.DEFAULT
    assert body["draft"]["contact_form"] is True
    assert body["published_at"] is None
    assert body["unpublished_changes"] is True
    assert SiteSettings.objects.count() == 1


def test_settings_edit_is_a_draft_until_published(signed_in):
    signed_in.patch("/settings", {"title": "New title", "showcase_layout": "train"})

    before = SiteSettings.objects.get().published
    published = signed_in.post("/settings/publish")
    after = signed_in.get("/settings").json()

    assert before == {}
    assert published.status_code == 200
    assert published.json() == {"version": 1}
    assert SiteSettings.objects.get().published["showcase_layout"] == "train"
    assert after["unpublished_changes"] is False
    assert Revision.objects.filter(entity="settings", version=1).exists()


def test_settings_seo_for_a_fixed_set_of_pages(signed_in):
    seo = {"home": {"title": "Home", "description": "TODO: description"}}

    response = signed_in.patch("/settings", {"seo": seo})

    assert response.status_code == 200, response.content
    assert response.json()["draft"]["seo"]["home"]["title"] == "Home"


@pytest.mark.parametrize(
    "field",
    [{"id": "x"}, {"published": {}}, {"published_at": None}, {"draft": {}}],
)
def test_settings_edit_cannot_reach_other_fields(signed_in, field):
    response = signed_in.patch("/settings", field)

    assert response.status_code == 400
    assert SiteSettings.objects.get().published == {}


def test_a_photo_can_be_cleared(signed_in):
    section = section_of(signed_in, "about")
    signed_in.patch(f"/sections/{section}", {"photo": {"media": None, "alt": "Me"}})

    response = signed_in.patch(f"/sections/{section}", {"photo": None})

    assert response.status_code == 200, response.content
    assert response.json()["draft"]["photo"] is None


def test_settings_offer_the_theme_presets(signed_in):
    presets = signed_in.get("/settings").json()["theme_presets"]

    assert presets["orange"] == theme.DEFAULT
    assert all(theme.failures(tokens) == [] for tokens in presets.values())
