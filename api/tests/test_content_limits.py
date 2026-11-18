"""Length and count limits, walked from the serializers so no field is missed."""

import pytest

from core import serializers as s
from core.models import Media
from tests.shapes import (
    ITEM_SHAPES,
    SECTION_SHAPES,
    list_paths,
    put,
    sample,
    text_paths,
)

pytestmark = pytest.mark.django_db


def text_cases(shapes, lookup):
    return [
        pytest.param(
            kind, path, field.max_length, id=f"{kind}:{'.'.join(map(str, path))}"
        )
        for kind in shapes
        for path, field in text_paths(lookup(kind))
    ]


def list_cases(shapes, lookup):
    return [
        pytest.param(
            kind, path, field.max_length, id=f"{kind}:{'.'.join(map(str, path))}"
        )
        for kind in shapes
        for path, field in list_paths(lookup(kind))
    ]


def section_of(api, kind):
    return api.post("/sections", {"type": kind, "title": "T"}).json()["id"]


def save_item(api, kind, data):
    return api.post(f"/sections/{section_of(api, kind)}/items", {"data": data})


def test_every_text_field_has_a_limit():
    shapes = [*s.SECTION_SHAPES.values(), *s.ITEM_TYPES.values(), s.Settings]
    for shape in shapes:
        for path, field in text_paths(shape):
            assert field.max_length, (shape.__name__, path)
        for path, field in list_paths(shape):
            assert field.max_length, (shape.__name__, path)


@pytest.mark.parametrize(
    ("kind", "path", "limit"), text_cases(ITEM_SHAPES, s.ITEM_TYPES.get)
)
def test_item_text_at_the_limit_is_kept_and_over_it_refused(
    signed_in, kind, path, limit
):
    shape = s.ITEM_TYPES[kind]

    at_limit = save_item(signed_in, kind, put(sample(shape), path, "a" * limit))
    over = signed_in.post(
        f"/sections/{at_limit.json()['section']}/items",
        {"data": put(sample(shape), path, "a" * (limit + 1))},
    )

    assert at_limit.status_code == 201, at_limit.content
    assert over.status_code == 400


@pytest.mark.parametrize(
    ("kind", "path", "limit"), text_cases(SECTION_SHAPES, s.SECTION_SHAPES.get)
)
def test_section_text_at_the_limit_is_kept_and_over_it_refused(
    signed_in, kind, path, limit
):
    shape = s.SECTION_SHAPES[kind]
    section = section_of(signed_in, kind)

    at_limit = signed_in.patch(
        f"/sections/{section}", put(sample(shape), path, "a" * limit)
    )
    over = signed_in.patch(
        f"/sections/{section}", put(sample(shape), path, "a" * (limit + 1))
    )

    assert at_limit.status_code == 200, at_limit.content
    assert over.status_code == 400


@pytest.mark.parametrize(
    ("kind", "path", "limit"), text_cases(["settings"], lambda _: s.Settings)
)
def test_settings_text_at_the_limit_is_kept_and_over_it_refused(
    signed_in, kind, path, limit
):
    at_limit = signed_in.patch("/settings", put(sample(s.Settings), path, "a" * limit))
    over = signed_in.patch(
        "/settings", put(sample(s.Settings), path, "a" * (limit + 1))
    )

    assert at_limit.status_code == 200, at_limit.content
    assert over.status_code == 400


@pytest.mark.parametrize(
    ("kind", "path", "limit"), list_cases(ITEM_SHAPES, s.ITEM_TYPES.get)
)
def test_item_lists_over_their_cap_are_refused(signed_in, kind, path, limit):
    shape = s.ITEM_TYPES[kind]
    body = sample(shape, lambda field: "x")
    one = body
    for step in path:
        one = one[step]
    entry = one[0]
    distinct = [
        f"{entry}{n}" if isinstance(entry, str) else entry for n in range(limit + 1)
    ]

    at_cap = save_item(signed_in, kind, put(sample(shape), path, distinct[:limit]))
    over = signed_in.post(
        f"/sections/{at_cap.json()['section']}/items",
        {"data": put(sample(shape), path, distinct)},
    )

    assert at_cap.status_code == 201, at_cap.content
    assert over.status_code == 400


@pytest.mark.parametrize("kind", ITEM_SHAPES)
def test_each_required_item_field_is_needed(signed_in, kind):
    shape = s.ITEM_TYPES[kind]
    section = section_of(signed_in, kind)
    required = [name for name, field in shape().fields.items() if field.required]

    for name in required:
        data = sample(shape)
        del data[name]
        response = signed_in.post(f"/sections/{section}/items", {"data": data})
        assert response.status_code == 400, name


def test_nested_required_fields_are_needed(signed_in):
    project = sample(s.Project)
    del project["images"][0]["alt"]
    links = sample(s.Project)
    del links["links"][0]["url"]

    assert save_item(signed_in, "projects", project).status_code == 400
    assert save_item(signed_in, "projects", links).status_code == 400


def test_a_section_edit_with_a_photo_missing_alt_text_is_refused(signed_in):
    section = section_of(signed_in, "about")

    response = signed_in.patch(f"/sections/{section}", {"photo": {"media": None}})

    assert response.status_code == 400


@pytest.mark.parametrize(
    "change",
    [
        {"status": "finished"},
        {"status": ["live"]},
        {"colour": "purple"},
        {"created": "2024-13"},
        {"created": "24-09"},
        {"tags": "Python"},
        {"tags": ["Python", "python"]},
        {"tags": [""]},
        {"links": [{"kind": "blog", "label": "x", "url": "https://a.test/"}]},
        {"links": [{"kind": "demo", "label": "x", "url": "https://a.test/", "x": 1}]},
        {"fields": [{"label": "Role"}]},
        {"images": [{"media": "not-an-id", "alt": "x"}]},
        {"images": [{"media": "00000000-0000-4000-8000-000000000000", "alt": "x"}]},
        {"images": [{"alt": "   "}]},
    ],
)
def test_bad_project_values_are_refused(signed_in, change):
    response = save_item(signed_in, "projects", {**sample(s.Project), **change})

    assert response.status_code == 400


def media(**extra):
    return Media.objects.create(
        storage_key=f"m/{len(extra)}-{Media.objects.count()}",
        content_type="image/webp",
        size=1,
        sha256="0" * 64,
        **extra,
    )


def test_an_image_slot_may_name_media_in_the_library(signed_in):
    image = media()
    project = {**sample(s.Project), "images": [{"media": str(image.id), "alt": "A"}]}

    assert save_item(signed_in, "projects", project).status_code == 201


def test_an_image_slot_may_not_name_trashed_media(signed_in):
    from django.utils import timezone

    image = media(trashed_at=timezone.now())
    project = {**sample(s.Project), "images": [{"media": str(image.id), "alt": "A"}]}

    assert save_item(signed_in, "projects", project).status_code == 400


@pytest.mark.parametrize(
    "change",
    [
        {"showcase_layout": "carousel"},
        {"contact_form": "yes"},
        {"seo": {"blog": {"title": "x"}}},
        {"theme": {"light": {"background": "#fff"}}},
        {"palette_mode": "random"},
        {"enabled_palette_ids": []},
        {"css": "body{}"},
    ],
)
def test_bad_settings_are_refused(signed_in, change):
    response = signed_in.patch("/settings", {**sample(s.Settings), **change})

    assert response.status_code == 400
