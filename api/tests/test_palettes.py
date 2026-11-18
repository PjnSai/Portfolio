"""Palettes: strict colour tokens, WCAG AA contrast in light and dark, preset
rules, the custom cap, the choice of palettes and what the public site gets."""

import copy
from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from core import admin_urls, content, theme
from core.authz import Level
from core.models import AuditLog, Palette, SiteSettings

pytestmark = pytest.mark.django_db

ORIGINAL = theme.DEFAULT_PALETTE


def preset(palette_id=ORIGINAL):
    return Palette.objects.get(id=palette_id)


def body(name="Mine", **changes):
    found = preset()
    data = {"name": name, "light": dict(found.light), "dark": dict(found.dark)}
    for mode, slots in changes.items():
        data[mode].update(slots)
    return data


def create(api, data=None):
    return api.post("/palettes", data or body())


def events():
    return list(AuditLog.objects.values_list("event", flat=True))


def site():
    return Client().get("/api/v1/site", secure=True).json()


def publish(api):
    response = api.post("/settings/publish", {"confirm": True})
    assert response.status_code == 200, response.content


# Contrast sums


@pytest.mark.parametrize(
    ("one", "two", "expected"),
    [
        ("#000000", "#FFFFFF", 21.0),
        ("#FFFFFF", "#FFFFFF", 1.0),
        ("#777777", "#FFFFFF", 4.48),
        ("#767676", "#FFFFFF", 4.54),
    ],
)
def test_contrast_ratio(one, two, expected):
    assert theme.contrast(one, two) == pytest.approx(expected, abs=0.01)


# Presets


def test_five_presets_exist_and_every_one_passes_in_both_modes():
    presets = Palette.objects.filter(kind="preset")

    assert presets.count() == 5
    for found in presets:
        for mode in theme.MODES:
            colours = getattr(found, mode)
            assert set(colours) == set(theme.SLOTS), found.name
            assert theme.failures(mode, colours) == [], found.name


def test_the_original_preset_uses_the_spec_colours():
    light = preset().light

    assert light["bg"] == "#F3EBDD"
    assert light["ink"] == "#17140F"
    assert [light[f"accent_{n}"] for n in theme.ACCENTS] == [
        "#2B57C9",
        "#F2A6C6",
        "#F2B835",
        "#5E621C",
    ]


def test_a_preset_cannot_be_edited(signed_in):
    response = signed_in.patch(f"/palettes/{ORIGINAL}", {"name": "Changed"})

    assert response.status_code == 409
    assert response.json()["code"] == "preset"
    assert preset().name == "Original"


def test_a_preset_cannot_be_deleted(signed_in):
    response = signed_in.post(f"/palettes/{ORIGINAL}/trash")

    assert response.status_code == 409
    assert response.json()["code"] == "preset"
    assert preset().trashed_at is None


def test_duplicating_a_preset_makes_an_editable_custom_copy(signed_in):
    response = signed_in.post(f"/palettes/{ORIGINAL}/duplicate")

    assert response.status_code == 201, response.content
    copied = response.json()
    assert copied["kind"] == "custom"
    assert copied["name"] == "Original copy"
    assert copied["light"] == preset().light
    edited = signed_in.patch(f"/palettes/{copied['id']}", {"name": "Mine"})
    assert edited.status_code == 200
    assert edited.json()["name"] == "Mine"
    assert "palette_duplicated" in events()


def test_a_duplicate_may_be_named(signed_in):
    response = signed_in.post(f"/palettes/{ORIGINAL}/duplicate", {"name": "Night"})

    assert response.json()["name"] == "Night"


# Colour format


@pytest.mark.parametrize(
    "colour",
    [
        "#FFF",
        "#fff",
        "red",
        "transparent",
        "#GGGGGG",
        "#E2531BFF",
        " #E2531B",
        "#E2531B ",
        "E2531B",
        "url(https://a.test/x)",
        "url(javascript:alert(1))",
        "var(--x)",
        "rgb(0,0,0)",
        "expression(alert(1))",
        "#E2531B;}body{display:none",
        "#E2531B;background:url(//a.test)",
        "#E2531B</style><script>",
        "",
        None,
        16777215,
        ["#E2531B"],
    ],
)
def test_colours_are_strict_six_digit_hex(signed_in, colour):
    response = create(signed_in, body(light={"primary": colour}))

    assert response.status_code == 400
    assert "primary" in response.json()["errors"]["light"]
    assert not Palette.objects.filter(kind="custom").exists()


def test_colours_are_stored_in_upper_case(signed_in):
    response = create(signed_in, body(light={"ink": "#17140f"}))

    assert response.status_code == 201, response.content
    assert response.json()["light"]["ink"] == "#17140F"


@pytest.mark.parametrize("mode", theme.MODES)
def test_every_slot_is_required(signed_in, mode):
    data = body()
    del data[mode]["on_accent_3"]

    response = create(signed_in, data)

    assert response.status_code == 400
    assert "on_accent_3" in response.json()["errors"][mode]


@pytest.mark.parametrize(
    "extra",
    [
        {"id": "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"},
        {"kind": "preset"},
        {"trashed_at": None},
        {"created_at": "2020-01-01T00:00:00Z"},
        {"css": "body{}"},
    ],
)
def test_fields_outside_the_shape_are_refused(signed_in, extra):
    created = create(signed_in, {**body(), **extra})
    copied = signed_in.post(f"/palettes/{ORIGINAL}/duplicate", extra)

    assert created.status_code == 400
    assert copied.status_code == 400
    assert not Palette.objects.filter(kind="custom").exists()


def test_an_extra_slot_is_refused(signed_in):
    response = create(signed_in, body(dark={"accent_5": "#000000"}))

    assert response.status_code == 400


def test_mass_assignment_on_edit_is_refused(signed_in):
    made = create(signed_in).json()

    response = signed_in.patch(f"/palettes/{made['id']}", {"kind": "preset"})

    assert response.status_code == 400
    assert Palette.objects.get(id=made["id"]).kind == "custom"


# Contrast in light and dark


def failing(mode, front, back):
    """A palette where only front on back (in one mode) is at 1:1."""
    data = body()
    data[mode][front] = data[mode][back]
    return data


@pytest.mark.parametrize("mode", theme.MODES)
@pytest.mark.parametrize(
    ("front", "back", "minimum"),
    theme.PAIRS,
    ids=[f"{f}-{b}" for f, b, _ in theme.PAIRS],
)
def test_each_failing_pair_is_refused_and_named(signed_in, mode, front, back, minimum):
    response = create(signed_in, failing(mode, front, back))

    assert response.status_code == 400
    errors = response.json()["errors"]
    other = "dark" if mode == "light" else "light"
    assert other not in errors
    message = (
        f"{mode.title()}: {front} on {back} is 1.00:1; it needs at least {minimum}:1."
    )
    assert message in errors[mode]


def test_a_pair_just_under_the_line_is_refused(signed_in):
    data = body(light={"ink": "#777777", "bg": "#FFFFFF", "surface": "#FFFFFF"})

    response = create(signed_in, data)

    assert response.status_code == 400
    assert (
        "Light: ink on bg is 4.48:1; it needs at least 4.5:1."
        in (response.json()["errors"]["light"])
    )


def test_an_edit_that_fails_contrast_leaves_the_palette_as_it_was(signed_in):
    made = create(signed_in).json()
    dark = {**made["dark"], "on_primary": made["dark"]["primary"]}

    response = signed_in.patch(f"/palettes/{made['id']}", {"dark": dark})

    assert response.status_code == 400
    assert Palette.objects.get(id=made["id"]).dark == made["dark"]


def test_a_passing_edit_is_kept_and_audited(signed_in):
    made = create(signed_in).json()
    light = {**made["light"], "primary": "#2B57C9", "on_primary": "#FFFFFF"}

    response = signed_in.patch(f"/palettes/{made['id']}", {"light": light})

    assert response.status_code == 200, response.content
    assert Palette.objects.get(id=made["id"]).light["primary"] == "#2B57C9"
    assert events()[-1] == "palette_changed"


# The custom cap


def test_at_most_twelve_custom_palettes(signed_in):
    for n in range(12):
        assert create(signed_in, body(name=f"P{n}")).status_code == 201

    over = create(signed_in, body(name="P12"))
    copied = signed_in.post(f"/palettes/{ORIGINAL}/duplicate")

    assert over.status_code == 409
    assert over.json()["code"] == "palette_limit"
    assert copied.status_code == 409
    assert Palette.objects.filter(kind="custom").count() == 12


def test_a_restore_that_would_pass_the_cap_is_refused(signed_in):
    first = create(signed_in).json()["id"]
    signed_in.post(f"/palettes/{first}/trash")
    for n in range(11):
        create(signed_in, body(name=f"P{n}"))
    assert create(signed_in, body(name="Last")).status_code == 201

    response = signed_in.post(f"/palettes/{first}/restore")

    assert response.status_code == 409
    assert response.json()["code"] == "palette_limit"


def test_trashed_palettes_do_not_count_towards_the_cap(signed_in):
    made = [create(signed_in, body(name=f"P{n}")).json()["id"] for n in range(12)]
    signed_in.post(f"/palettes/{made[0]}/trash")

    assert create(signed_in).status_code == 201


# Delete goes to the trash


def test_deleting_a_custom_palette_moves_it_to_the_trash(signed_in):
    made = create(signed_in).json()["id"]

    response = signed_in.post(f"/palettes/{made}/trash")

    assert response.status_code == 200
    assert signed_in.get(f"/palettes/{made}").status_code == 404
    trash = signed_in.get("/trash").json()["results"]
    assert {"entity": "palette", "id": made} == {
        k: trash[0][k] for k in ("entity", "id")
    }
    assert made not in [p["id"] for p in signed_in.get("/palettes").json()["palettes"]]
    restored = signed_in.post(f"/palettes/{made}/restore")
    assert restored.status_code == 200
    assert events()[-2:] == ["palette_trashed", "palette_restored"]


def test_the_default_palette_cannot_be_deleted(signed_in):
    made = create(signed_in).json()["id"]
    use(signed_in, "fixed", made, [made])

    response = signed_in.post(f"/palettes/{made}/trash")

    assert response.status_code == 409
    assert response.json()["code"] == "default"


def test_the_live_default_cannot_be_deleted_while_the_draft_moves_on(signed_in):
    made = create(signed_in).json()["id"]
    use(signed_in, "fixed", made, [made])
    publish(signed_in)
    use(signed_in, "fixed", ORIGINAL, [ORIGINAL])

    response = signed_in.post(f"/palettes/{made}/trash")

    assert response.status_code == 409


def test_deleting_an_enabled_palette_takes_it_off_the_list(signed_in):
    made = create(signed_in).json()["id"]
    use(signed_in, "pick", ORIGINAL, [ORIGINAL, made])

    signed_in.post(f"/palettes/{made}/trash")

    assert SiteSettings.objects.get().draft["enabled_palette_ids"] == [ORIGINAL]


def test_old_trashed_palettes_are_purged():
    made = Palette.objects.create(name="Old", light={}, dark={})
    Palette.objects.filter(id=made.id).update(
        trashed_at=timezone.now() - timedelta(days=31)
    )

    assert content.purge_trash()["palettes"] == 1
    assert not Palette.objects.filter(id=made.id).exists()
    assert Palette.objects.filter(kind="preset").count() == 5


# Mode, default and enabled list


def use(api, mode, default, enabled):
    response = api.post(
        "/palettes/use",
        {
            "palette_mode": mode,
            "default_palette_id": default,
            "enabled_palette_ids": enabled,
        },
    )
    assert response.status_code == 200, response.content
    return response


def test_the_settings_start_fixed_on_the_original():
    draft = content.site_settings().draft

    assert draft["palette_mode"] == "fixed"
    assert draft["default_palette_id"] == ORIGINAL
    assert draft["enabled_palette_ids"] == [ORIGINAL]


@pytest.mark.parametrize("mode", ["fixed", "rotate", "pick"])
def test_each_mode_can_be_chosen_and_is_audited(signed_in, mode):
    others = [str(p.id) for p in Palette.objects.filter(kind="preset")]

    response = use(signed_in, mode, ORIGINAL, others)

    assert response.json()["palette_mode"] == mode
    draft = SiteSettings.objects.get().draft
    assert draft["enabled_palette_ids"] == others
    entry = AuditLog.objects.order_by("-seq").first()
    assert entry.event == "palettes_chosen"
    assert entry.detail == {"mode": mode, "default": ORIGINAL, "enabled": 5}


@pytest.mark.parametrize(
    "change",
    [
        {"palette_mode": "random"},
        {"palette_mode": None},
        {"enabled_palette_ids": []},
        {"default_palette_id": "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"},
        {"default_palette_id": "not-an-id"},
        {"enabled_palette_ids": [ORIGINAL, ORIGINAL]},
        {"enabled_palette_ids": [ORIGINAL, "00000000-0000-4000-8000-000000000000"]},
        {"enabled_palette_ids": ORIGINAL},
        {"extra": True},
    ],
)
def test_bad_choices_are_refused(signed_in, change):
    choice = {
        "palette_mode": "pick",
        "default_palette_id": ORIGINAL,
        "enabled_palette_ids": [ORIGINAL],
        **change,
    }

    response = signed_in.post("/palettes/use", choice)

    assert response.status_code == 400
    assert SiteSettings.objects.get().draft["palette_mode"] == "fixed"


def test_a_trashed_palette_cannot_be_enabled(signed_in):
    made = create(signed_in).json()["id"]
    signed_in.post(f"/palettes/{made}/trash")

    response = signed_in.post(
        "/palettes/use",
        {
            "palette_mode": "pick",
            "default_palette_id": ORIGINAL,
            "enabled_palette_ids": [ORIGINAL, made],
        },
    )

    assert response.status_code == 400


def test_the_settings_edit_checks_the_same_rules(signed_in):
    response = signed_in.patch("/settings", {"enabled_palette_ids": []})
    other = signed_in.patch(
        "/settings", {"default_palette_id": "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"}
    )

    assert response.status_code == 400
    assert other.status_code == 400


def test_the_old_theme_field_is_gone(signed_in):
    response = signed_in.patch(
        "/settings", {"theme": {"light": {"background": "#F3EBDD"}}}
    )

    assert response.status_code == 400
    assert "theme" not in SiteSettings.objects.get().draft


def test_the_list_shows_presets_first_and_the_choice(signed_in):
    create(signed_in)

    listed = signed_in.get("/palettes").json()

    kinds = [p["kind"] for p in listed["palettes"]]
    assert kinds == ["preset"] * 5 + ["custom"]
    assert listed["palettes"][4]["id"] == ORIGINAL
    assert listed["default_palette_id"] == ORIGINAL
    assert listed["max_custom"] == 12


def test_adding_a_palette_is_audited(signed_in):
    made = create(signed_in).json()["id"]

    entry = AuditLog.objects.order_by("-seq").first()
    assert entry.event == "palette_added"
    assert entry.detail == {"palette": made}


# Publishing and the public site


def test_the_site_gets_the_mode_the_default_and_only_enabled_palettes(signed_in):
    made = create(signed_in, body(name="Night")).json()["id"]
    create(signed_in, body(name="Not enabled"))
    use(signed_in, "rotate", made, [made, ORIGINAL])
    publish(signed_in)

    document = site()

    assert document["settings"]["palette_mode"] == "rotate"
    assert document["settings"]["default_palette_id"] == made
    assert document["settings"]["enabled_palette_ids"] == [made, ORIGINAL]
    assert [p["id"] for p in document["palettes"]] == [made, ORIGINAL]
    assert document["palettes"][0]["name"] == "Night"
    assert set(document["palettes"][0]) == {"id", "name", "light", "dark"}
    assert set(document["palettes"][0]["light"]) == set(theme.SLOTS)
    assert "palettes" not in document["settings"]


def test_palette_edits_wait_for_publish(signed_in):
    made = create(signed_in).json()
    use(signed_in, "fixed", made["id"], [made["id"]])
    publish(signed_in)
    assert signed_in.get("/settings").json()["unpublished_changes"] is False
    light = {**made["light"], "primary": "#2B57C9", "on_primary": "#FFFFFF"}

    signed_in.patch(f"/palettes/{made['id']}", {"light": light})

    assert site()["palettes"][0]["light"]["primary"] == made["light"]["primary"]
    assert signed_in.get("/settings").json()["unpublished_changes"] is True
    publish(signed_in)
    assert site()["palettes"][0]["light"]["primary"] == "#2B57C9"


def test_an_unpublished_site_has_no_palettes():
    assert site()["palettes"] == []


def test_a_palette_name_with_contact_details_needs_confirming(signed_in):
    made = create(signed_in, body(name="me@example.com")).json()["id"]
    use(signed_in, "pick", ORIGINAL, [ORIGINAL, made])

    response = signed_in.post("/settings/publish")

    assert response.status_code == 409
    assert response.json()["code"] == "privacy_check"


def test_publishing_settings_rebuilds_the_site(signed_in):
    use(signed_in, "pick", ORIGINAL, [ORIGINAL])

    publish(signed_in)

    assert "site_deploy_requested" in events()


# Every new route is behind the admin guard (tests/test_routes.py then tries
# each with no, expired, revoked, wrong and correct sessions and without CSRF).


def test_every_palette_route_needs_a_session():
    found = {
        str(p.pattern): p.callback.admin_level
        for p in admin_urls.urlpatterns
        if str(p.pattern).startswith("palettes")
    }

    assert set(found) == {
        "palettes",
        "palettes/use",
        "palettes/<uuid:palette_id>",
        "palettes/<uuid:palette_id>/duplicate",
        "palettes/<uuid:palette_id>/trash",
        "palettes/<uuid:palette_id>/restore",
    }
    assert set(found.values()) == {Level.SESSION}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/palettes"),
        ("POST", "/palettes"),
        ("POST", "/palettes/use"),
        ("GET", f"/palettes/{ORIGINAL}"),
        ("PATCH", f"/palettes/{ORIGINAL}"),
        ("POST", f"/palettes/{ORIGINAL}/duplicate"),
        ("POST", f"/palettes/{ORIGINAL}/trash"),
        ("POST", f"/palettes/{ORIGINAL}/restore"),
    ],
)
def test_palette_routes_refuse_without_a_session(api, passkey, method, path):
    before = copy.deepcopy(preset().light)

    response = api.request(method, path)

    assert response.status_code == 401
    assert preset().light == before
    assert Palette.objects.count() == 5
