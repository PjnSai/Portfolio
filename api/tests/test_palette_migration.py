"""Migration 0010 moves the phase 2B theme into palettes and drops it; 0011 makes
preset A the default and puts preset E's light primary back to the spec orange."""

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

pytestmark = pytest.mark.django_db

BEFORE = [("core", "0008_site_deploy_status")]
AFTER = [("core", "0010_palette_data")]
LATEST = [("core", "0011_default_palette_a")]
ORIGINAL = "b399fb8f-5de4-462d-98f5-a81bf8046a6f"
PRESET_A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"

OLD_DEFAULT = {
    "light": {
        "background": "#f5efe3",
        "ink": "#161412",
        "accent": "#e2531b",
        "on_accent": "#161412",
    },
    "dark": {
        "background": "#161412",
        "ink": "#f5efe3",
        "accent": "#f06a35",
        "on_accent": "#161412",
    },
}
BLUE = {
    "light": {**OLD_DEFAULT["light"], "accent": "#2a55c7", "on_accent": "#ffffff"},
    "dark": {**OLD_DEFAULT["dark"], "accent": "#7a9cf0"},
}


def migrate(target):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(target)
    return executor.loader.project_state(target).apps


@pytest.fixture
def old_settings():
    """Go back to before palettes, then give a factory for 2B settings rows."""
    apps = migrate(BEFORE)
    model = apps.get_model("core", "SiteSettings")
    model.objects.all().delete()

    def make(draft_theme, published_theme=None):
        published = {"title": "T", "theme": published_theme} if published_theme else {}
        model.objects.create(
            draft={"title": "T", "theme": draft_theme}, published=published
        )

    yield make
    migrate(LATEST)


def after():
    apps = migrate(AFTER)
    return apps.get_model("core", "SiteSettings").objects.get(), apps.get_model(
        "core", "Palette"
    )


def test_a_custom_theme_becomes_a_custom_palette(old_settings):
    from core import theme

    old_settings(BLUE, BLUE)

    row, Palette = after()

    custom = Palette.objects.get(kind="custom")
    assert custom.light["bg"] == "#F5EFE3"
    assert custom.light["primary"] == "#2A55C7"
    assert custom.light["on_primary"] == "#FFFFFF"
    assert custom.dark["primary"] == "#7A9CF0"
    for mode in theme.MODES:
        assert set(getattr(custom, mode)) == set(theme.SLOTS)
        assert theme.failures(mode, getattr(custom, mode)) == []
    assert "theme" not in row.draft
    assert "theme" not in row.published
    assert row.draft["palette_mode"] == "fixed"
    assert row.draft["default_palette_id"] == str(custom.id)
    assert row.draft["enabled_palette_ids"] == [str(custom.id)]
    assert row.published["palettes"][0]["light"] == custom.light
    assert row.draft["title"] == "T"


def test_an_untouched_default_theme_becomes_the_original_preset(old_settings):
    old_settings(OLD_DEFAULT)

    row, Palette = after()

    assert not Palette.objects.filter(kind="custom").exists()
    assert Palette.objects.filter(kind="preset").count() == 5
    assert row.draft["default_palette_id"] == ORIGINAL
    assert row.published == {}


def test_a_live_theme_that_differs_from_the_draft_is_kept_for_the_site(old_settings):
    old_settings(OLD_DEFAULT, BLUE)

    row, Palette = after()

    live = Palette.objects.get(kind="custom")
    assert row.draft["default_palette_id"] == ORIGINAL
    assert row.published["default_palette_id"] == str(live.id)
    assert row.published["palettes"][0]["light"]["primary"] == "#2A55C7"


def test_preset_a_becomes_the_draft_default_and_is_enabled(old_settings):
    old_settings(BLUE, BLUE)
    row, Palette = after()
    custom = str(Palette.objects.get(kind="custom").id)

    apps = migrate(LATEST)

    row = apps.get_model("core", "SiteSettings").objects.get()
    assert row.draft["default_palette_id"] == PRESET_A
    assert row.draft["enabled_palette_ids"] == [PRESET_A, custom]
    assert row.published["default_palette_id"] == custom
    original = apps.get_model("core", "Palette").objects.get(id=ORIGINAL)
    assert original.light["primary"] == "#FF5A1F"
    assert original.kind == "preset"


def test_preset_a_is_not_listed_twice(old_settings):
    old_settings(OLD_DEFAULT)
    after()
    model = migrate(AFTER).get_model("core", "SiteSettings")
    row = model.objects.get()
    row.draft = {**row.draft, "enabled_palette_ids": [ORIGINAL, PRESET_A]}
    row.save()

    row = migrate(LATEST).get_model("core", "SiteSettings").objects.get()

    assert row.draft["enabled_palette_ids"] == [PRESET_A, ORIGINAL]


def test_0011_can_be_undone(old_settings):
    old_settings(OLD_DEFAULT)
    after()
    migrate(LATEST)

    apps = migrate(AFTER)

    row = apps.get_model("core", "SiteSettings").objects.get()
    assert row.draft["default_palette_id"] == ORIGINAL
    original = apps.get_model("core", "Palette").objects.get(id=ORIGINAL)
    assert original.light["primary"] == "#E8551C"
