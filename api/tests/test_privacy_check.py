"""Before publishing, the owner is warned about personal contact details in text."""

import pytest

from core import privacy
from core.models import Section, SiteSettings

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("Write to me at someone@example.co.uk", "email"),
        ("first.last+tag@mail.example.test", "email"),
        ("Call 07700 900123", "phone"),
        ("Call 07700900123", "phone"),
        ("+44 7700 900123", "phone"),
        ("+44 (0)20 7946 0018", "phone"),
        ("020 7946 0018", "phone"),
        ("0161-496-0000", "phone"),
        ("Based in SW1A 1AA", "postcode"),
        ("m1 1ae", "postcode"),
        ("EC1A1BB", "postcode"),
    ],
)
def test_personal_details_are_found(text, kind):
    assert [found["kind"] for found in privacy.scan({"body": text})] == [kind]


@pytest.mark.parametrize(
    "text",
    [
        "Built in 2024, released 2025-01.",
        "From 2021-09 to 2024-06",
        "Scored 98 out of 100 on 12 tests",
        "Version 1.2.3 and build 20241105",
        "https://github.test/owner/repo",
        "Python 3.13, Node 24",
        "Up 99.9% over 30 days",
        "Room 2B in block 4",
        "@owner on GitHub",
    ],
)
def test_ordinary_text_is_not_flagged(text):
    assert privacy.scan({"body": text}) == []


def test_every_string_in_nested_data_is_checked():
    found = privacy.scan(
        {"title": "Ledger", "fields": [{"label": "Contact", "value": "a@b.test"}]}
    )

    assert found == [{"where": "fields 1 value", "kind": "email", "text": "a@b.test"}]


def add_section(api, body):
    section = api.post("/sections", {"type": "text", "title": "About"}).json()
    api.patch(f"/sections/{section['id']}", {"body": body})
    return section["id"]


def test_section_detail_lists_warnings(signed_in):
    section = add_section(signed_in, "Mail someone@example.test")

    detail = signed_in.get(f"/sections/{section}").json()

    assert detail["privacy_warnings"] == [
        {"where": "body", "kind": "email", "text": "someone@example.test"}
    ]


def test_publish_with_warnings_needs_confirmation(signed_in):
    section = add_section(signed_in, "Phone 07700 900123")

    refused = signed_in.post(f"/sections/{section}/publish")
    still_draft = Section.objects.get(id=section).published
    confirmed = signed_in.post(f"/sections/{section}/publish", {"confirm": True})

    assert refused.status_code == 409
    assert refused.json()["code"] == "privacy_check"
    assert refused.json()["warnings"][0]["kind"] == "phone"
    assert still_draft == {}
    assert confirmed.status_code == 200
    assert "07700" in Section.objects.get(id=section).published["body"]


def test_items_are_checked_too(signed_in):
    section = signed_in.post("/sections", {"type": "links", "title": "L"}).json()
    signed_in.post(
        f"/sections/{section['id']}/items",
        {"data": {"label": "Office SW1A 1AA", "url": "https://a.test/"}},
    )

    refused = signed_in.post(f"/sections/{section['id']}/publish")

    assert refused.status_code == 409
    assert refused.json()["warnings"][0]["where"] == "Office SW1A 1AA: label"


def test_hidden_items_are_not_published_so_not_checked(signed_in):
    section = signed_in.post("/sections", {"type": "links", "title": "L"}).json()
    item = signed_in.post(
        f"/sections/{section['id']}/items",
        {"data": {"label": "a@b.test", "url": "https://a.test/"}},
    ).json()
    signed_in.post(f"/items/{item['id']}/visibility", {"visible": False})

    assert signed_in.post(f"/sections/{section['id']}/publish").status_code == 200


def test_publish_without_warnings_needs_no_confirmation(signed_in):
    section = add_section(signed_in, "Plain text.")

    assert signed_in.post(f"/sections/{section}/publish").status_code == 200


def test_settings_publish_is_checked(signed_in):
    signed_in.patch("/settings", {"description": "Mail a@b.test"})

    refused = signed_in.post("/settings/publish")
    confirmed = signed_in.post("/settings/publish", {"confirm": True})

    assert refused.status_code == 409
    assert confirmed.status_code == 200
    assert SiteSettings.objects.get().published["description"] == "Mail a@b.test"


@pytest.mark.parametrize("confirm", ["yes", 1, None, ["true"]])
def test_confirmation_must_be_true_or_false(signed_in, confirm):
    section = add_section(signed_in, "Plain text.")

    response = signed_in.post(f"/sections/{section}/publish", {"confirm": confirm})

    assert response.status_code == 400
