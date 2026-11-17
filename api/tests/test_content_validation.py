"""Every content input is validated, and only the fields named for it are read."""

import pytest

from core.models import Section, SectionItem

pytestmark = pytest.mark.django_db

PROJECT = {"title": "Ledger", "summary": "", "body": ""}
VALID_ITEMS = {
    "projects": {
        "title": "Ledger",
        "summary": "A small tool.",
        "body": "Built the **API**.",
        "fields": [{"label": "Role", "value": "Sole developer"}],
    },
    "experience": {
        "organisation": "TODO: employer",
        "role": "TODO: role",
        "location": "",
        "start": "2024-09",
        "end": "",
        "summary": "",
    },
    "education": {
        "institution": "TODO: university",
        "qualification": "TODO: degree",
        "start": "2021-09",
        "end": "2024-06",
        "summary": "",
    },
    "skills": {"name": "Languages", "skills": ["Python", "TypeScript"]},
    "gallery": {"alt": "Screenshot of the dashboard", "caption": ""},
    "links": {"label": "Code", "url": "https://github.test/owner"},
}


@pytest.fixture
def section(signed_in):
    return signed_in.post("/sections", {"type": "projects", "title": "Projects"}).json()


def section_of(api, kind):
    return api.post("/sections", {"type": kind, "title": kind.title()}).json()


@pytest.mark.parametrize("kind", sorted(VALID_ITEMS))
def test_valid_item_of_each_type_is_accepted(signed_in, kind):
    target = section_of(signed_in, kind)

    response = signed_in.post(
        f"/sections/{target['id']}/items", {"data": VALID_ITEMS[kind]}
    )

    assert response.status_code == 201, response.content


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"type": "projects"},
        {"title": "No type"},
        {"type": "blog", "title": "Unknown type"},
        {"type": "projects", "title": ""},
        {"type": "projects", "title": "   "},
        {"type": "projects", "title": "x" * 81},
        {"type": "projects", "title": 12},
        {"type": "projects", "title": ["a"]},
        {"type": "projects", "title": "Line\nbreak"},
        {"type": "projects", "title": "Null\x00byte"},
        {"type": ["projects"], "title": "List type"},
    ],
)
def test_bad_new_section_is_refused(signed_in, body):
    response = signed_in.post("/sections", body)

    assert response.status_code == 400
    assert Section.objects.count() == 0


@pytest.mark.parametrize(
    "field",
    [
        {"id": "00000000-0000-4000-8000-000000000000"},
        {"position": 0},
        {"visible": False},
        {"published": {"title": "Injected"}},
        {"published_at": "2020-01-01T00:00:00Z"},
        {"trashed_at": None},
        {"draft": {"title": "x"}},
        {"is_admin": True},
    ],
)
def test_fields_not_named_for_a_new_section_are_refused(signed_in, field):
    response = signed_in.post("/sections", {"type": "text", "title": "T", **field})

    assert response.status_code == 400
    assert Section.objects.count() == 0


@pytest.mark.parametrize(
    "field",
    [
        {"type": "hero"},
        {"published": {"title": "Live without publishing"}},
        {"position": 99},
        {"trashed_at": "2020-01-01T00:00:00Z"},
        {"id": "00000000-0000-4000-8000-000000000000"},
    ],
)
def test_section_edit_cannot_reach_other_fields(signed_in, section, field):
    response = signed_in.patch(f"/sections/{section['id']}", {"title": "New", **field})
    stored = Section.objects.get(id=section["id"])

    assert response.status_code == 400
    assert stored.type == "projects"
    assert stored.published == {}
    assert stored.draft["title"] == "Projects"


@pytest.mark.parametrize(
    "body",
    [
        {"title": ""},
        {"title": None},
        {"body": 5},
        {"body": "x" * 20001},
        {"body": "bell\x07"},
    ],
)
def test_bad_section_edit_is_refused(signed_in, section, body):
    response = signed_in.patch(f"/sections/{section['id']}", body)

    assert response.status_code == 400


def test_markdown_keeps_line_breaks(signed_in, section):
    text = "First line\n\n- point\n\tindented"

    response = signed_in.patch(f"/sections/{section['id']}", {"body": text})

    assert response.json()["draft"]["body"] == text


@pytest.mark.parametrize("visible", [None, "false", 0, 1, "yes", []])
def test_visibility_must_be_true_or_false(signed_in, section, visible):
    response = signed_in.post(
        f"/sections/{section['id']}/visibility", {"visible": visible}
    )

    assert response.status_code == 400
    assert Section.objects.get(id=section["id"]).visible is True


def test_visibility_takes_no_other_field(signed_in, section):
    response = signed_in.post(
        f"/sections/{section['id']}/visibility", {"visible": False, "position": 5}
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "kind,data",
    [
        ("projects", {}),
        ("projects", {**PROJECT, "title": ""}),
        ("projects", {**PROJECT, "title": "x" * 121}),
        ("projects", {**PROJECT, "slug": "extra"}),
        ("projects", {**PROJECT, "fields": [{"label": "Only label"}]}),
        ("projects", {**PROJECT, "fields": [{"label": "a", "value": "b", "x": 1}]}),
        ("projects", {**PROJECT, "fields": [{"label": "a", "value": "b"}] * 21}),
        ("projects", {**PROJECT, "fields": "Role: author"}),
        ("experience", {**VALID_ITEMS["experience"], "start": "2024"}),
        ("experience", {**VALID_ITEMS["experience"], "start": "2024-13"}),
        ("experience", {**VALID_ITEMS["experience"], "start": "Sept 2024"}),
        ("experience", {**VALID_ITEMS["experience"], "end": "2023-01"}),
        ("education", {**VALID_ITEMS["education"], "qualification": ""}),
        ("skills", {"name": "Tools", "skills": "Python, Go"}),
        ("skills", {"name": "Tools", "skills": [""]}),
        ("skills", {"name": "Tools", "skills": [3]}),
        ("skills", {"name": "Tools", "skills": ["x"] * 51}),
        ("gallery", {"alt": "", "caption": "Alt text is required"}),
        ("links", {"label": "Code", "url": "javascript:alert(1)"}),
        ("links", {"label": "Code", "url": "http://plain.test"}),
        ("links", {"label": "Code", "url": "data:text/html,hi"}),
        ("links", {"label": "Code", "url": "https://"}),
        ("links", {"label": "Code", "url": "mailto:someone@example.test"}),
        ("links", {"label": "Code", "url": "https://user:pass@host.test"}),
    ],
)
def test_bad_item_is_refused(signed_in, kind, data):
    target = section_of(signed_in, kind)

    response = signed_in.post(f"/sections/{target['id']}/items", {"data": data})

    assert response.status_code == 400
    assert SectionItem.objects.count() == 0


@pytest.mark.parametrize(
    "body",
    [
        {"data": PROJECT, "visible": False},
        {"data": PROJECT, "position": 3},
        {"data": PROJECT, "section": "00000000-0000-4000-8000-000000000000"},
        {"data": PROJECT, "published": PROJECT},
        {"data": "Ledger"},
        {},
    ],
)
def test_new_item_takes_only_its_data(signed_in, section, body):
    response = signed_in.post(f"/sections/{section['id']}/items", body)

    assert response.status_code == 400
    assert SectionItem.objects.count() == 0


def test_item_edit_cannot_move_it_to_another_section(signed_in, section):
    other = section_of(signed_in, "projects")
    item = signed_in.post(f"/sections/{section['id']}/items", {"data": PROJECT}).json()

    response = signed_in.patch(
        f"/items/{item['id']}", {"data": PROJECT, "section": other["id"]}
    )

    assert response.status_code == 400
    assert str(SectionItem.objects.get(id=item["id"]).section_id) == section["id"]


@pytest.mark.parametrize("body", ["[]", "null", '"text"', "not json", "{"])
def test_body_must_be_a_json_object(signed_in, body):
    signed_in.fetch_csrf()
    response = signed_in.client.post(
        "/api/v1/admin/sections",
        body,
        content_type="application/json",
        secure=True,
        headers=signed_in.headers(),
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "params",
    [{"page": "0"}, {"page": "-1"}, {"page": "two"}, {"page": "1", "size": "500"}],
)
def test_bad_paging_is_refused(signed_in, params):
    assert signed_in.get("/sections", params).status_code == 400
    assert signed_in.get("/trash", params).status_code == 400


def test_text_is_stored_as_typed_not_turned_into_html(signed_in, section):
    payload = "<script>alert(1)</script><img src=x onerror=alert(1)>"

    response = signed_in.patch(f"/sections/{section['id']}", {"body": payload})

    # Stored as plain text; it is escaped or sanitised wherever it is shown.
    assert response.status_code == 200
    assert response.json()["draft"]["body"] == payload
    assert response["Content-Type"] == "application/json"
