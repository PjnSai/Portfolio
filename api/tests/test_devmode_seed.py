"""Sample content for the local development mode (devmode.seed)."""

from pathlib import Path

import pytest
from django.apps import apps
from django.db import connection

from core import content, cv, privacy
from core.models import (
    AbuseCount,
    Alert,
    ContactMessage,
    CvVersion,
    Palette,
    Section,
    SiteSettings,
)
from devmode import seed
from tests.test_devmode_guards import run_launcher

pytestmark = pytest.mark.django_db
API = Path(__file__).resolve().parent.parent

# Keys whose values are fixed choices, ids, dates or addresses, not words.
NOT_TEXT = {"id", "slug", "type", "status", "colour", "created", "start", "end", "url"}
NOT_TEXT_SETTINGS = {
    "palette_mode",
    "default_palette_id",
    "enabled_palette_ids",
    "showcase_layout",
    "palettes",
}


@pytest.fixture(autouse=True)
def stores(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    settings.CV_ROOT = tmp_path / "cv"


def counts():
    return {
        model.__name__: model.objects.count()
        for model in apps.get_app_config("core").get_models()
    }


def words(value, key=None):
    """Every string in value that is meant to be read, with where it was."""
    if key in NOT_TEXT:
        return
    if isinstance(value, str):
        yield key, value
    elif isinstance(value, dict):
        for name, inner in value.items():
            yield from words(inner, name)
    elif isinstance(value, list):
        for inner in value:
            yield from words(inner, key)


def test_every_public_section_kind_is_published():
    seed.fill()
    site = content.public_site()
    kinds = {section["type"] for section in site["sections"]}
    assert {"hero", "about", "projects", "contact"} <= kinds
    projects = next(s for s in site["sections"] if s["type"] == "projects")
    assert len(projects["items"]) == 2
    assert all(item["data"]["body"] for item in projects["items"])
    assert all(item.get("slug") for item in projects["items"])


def test_drafts_match_what_is_live():
    """The admin opens on the same content the public site shows."""
    seed.fill()
    for section in Section.objects.all():
        assert not content.unpublished_changes(section), section.type
    assert not content.settings_unpublished(SiteSettings.objects.get())


def test_a_sample_palette_is_enabled_and_settings_are_live():
    seed.fill()
    palette = Palette.objects.get(name=seed.PALETTE_NAME)
    assert palette.kind == Palette.Kind.CUSTOM
    live = SiteSettings.objects.get().published
    assert str(palette.id) in live["enabled_palette_ids"]
    assert live["title"].startswith("SAMPLE")


def test_a_sample_cv_is_live_with_every_switch_on():
    seed.fill()
    item = cv.live()
    assert item is not None
    assert cv.read(item).startswith(b"%PDF-")
    assert cv.switches() == {"view": True, "request": True, "instant_download": True}


def test_inbox_abuse_counts_and_alerts_are_seeded():
    seed.fill()
    kinds = set(ContactMessage.objects.values_list("kind", flat=True))
    assert kinds == {"message", "cv_request"}
    assert AbuseCount.objects.filter(count__gt=0).exists()
    assert Alert.objects.filter(seen_at=None).exists()


def test_seeding_twice_changes_nothing():
    seed.fill()
    first, site = counts(), content.public_site()
    seed.fill()
    assert counts() == first
    assert content.public_site() == site


def test_existing_content_is_left_alone_without_reset():
    seed.fill()
    hero = Section.objects.get(type="hero")
    hero.draft = {**hero.draft, "body": "The owner's own words."}
    hero.save()
    seed.fill()
    assert Section.objects.get(type="hero").draft["body"] == "The owner's own words."


def test_reset_puts_the_sample_content_back(tmp_path):
    seed.fill()
    first = counts()
    Section.objects.get(type="hero").delete()
    ContactMessage.objects.all().delete()
    seed.reset()
    after = counts()
    # The audit log keeps growing: it is append-only and never wiped.
    assert {k: v for k, v in after.items() if k != "AuditLog"} == {
        k: v for k, v in first.items() if k != "AuditLog"
    }
    assert CvVersion.objects.count() == 1


def test_reset_keeps_the_owner_and_passkeys():
    from core.models import Owner

    seed.fill()
    owner = Owner.objects.get().id
    seed.reset()
    assert Owner.objects.get().id == owner


def test_all_public_text_is_marked_as_sample():
    seed.fill()
    site = content.public_site()
    unmarked = [
        (key, text)
        for section in site["sections"]
        for key, text in words(section)
        if text and not text.startswith("SAMPLE")
    ]
    assert unmarked == []
    settings_text = {
        k: v for k, v in site["settings"].items() if k not in NOT_TEXT_SETTINGS
    }
    assert [t for _, t in words(settings_text) if not t.startswith("SAMPLE")] == []


def test_no_contact_details_reach_the_public_site():
    seed.fill()
    assert privacy.scan(content.public_site()["sections"]) == []
    for section in Section.objects.all():
        assert content.publish_warnings(section) == [], section.type


def test_sample_senders_are_placeholders():
    seed.fill()
    for message in ContactMessage.objects.all():
        assert message.name.startswith("SAMPLE")
        assert message.body.startswith("SAMPLE")
        assert message.email.endswith("@example.com")
    for alert in Alert.objects.all():
        assert alert.summary.startswith("SAMPLE")


def test_the_seed_refuses_a_database_not_ending_in_dev():
    assert not connection.settings_dict["NAME"].endswith("_dev")
    with pytest.raises(seed.guards.Refused):
        seed.run(reset=False)
    assert Section.objects.count() == 0


@pytest.mark.parametrize("name", ["portfolio", "portfolio_e2e", "dev", "x_dev_x"])
def test_the_name_check_refuses(name):
    with pytest.raises(seed.guards.Refused):
        seed.require_dev_database(name)


def test_the_name_check_passes_a_dev_database():
    seed.require_dev_database("portfolio_dev")


def test_the_seed_command_refuses_a_database_not_ending_in_dev():
    url = "postgres://postgres:postgres@127.0.0.1:55432/portfolio_e2e"
    result = run_launcher("seed", DEV_DATABASE_URL=url)
    assert result.returncode != 0
    assert "_dev" in result.stderr
