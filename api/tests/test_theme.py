"""Theme colours are tokens, and every pair must pass WCAG AA contrast."""

import copy

import pytest

from core import theme
from core.models import SiteSettings

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    ("one", "two", "expected"),
    [
        ("#000000", "#ffffff", 21.0),
        ("#ffffff", "#ffffff", 1.0),
        ("#777777", "#ffffff", 4.48),
        ("#767676", "#ffffff", 4.54),
    ],
)
def test_contrast_ratio(one, two, expected):
    assert theme.contrast(one, two) == pytest.approx(expected, abs=0.01)


def test_the_default_and_every_preset_pass():
    for tokens in (theme.DEFAULT, *theme.PRESETS.values()):
        assert theme.failures(tokens) == []


@pytest.mark.parametrize(
    ("mode", "token", "colour"),
    [
        ("light", "ink", "#bbbbbb"),
        ("light", "accent", "#f5efe3"),
        ("light", "on_accent", "#e2531b"),
        ("dark", "ink", "#222222"),
        ("dark", "background", "#e2531b"),
    ],
)
def test_a_failing_pair_is_refused(signed_in, mode, token, colour):
    tokens = copy.deepcopy(theme.DEFAULT)
    tokens[mode][token] = colour

    response = signed_in.patch("/settings", {"theme": tokens})

    assert response.status_code == 400
    assert "theme" in response.json()["errors"]
    assert SiteSettings.objects.get().draft["theme"] == theme.DEFAULT


def test_a_passing_custom_theme_is_kept(signed_in):
    tokens = copy.deepcopy(theme.DEFAULT)
    tokens["light"]["accent"] = "#2a55c7"
    tokens["light"]["on_accent"] = "#ffffff"

    response = signed_in.patch("/settings", {"theme": tokens})

    assert response.status_code == 200, response.content
    assert response.json()["draft"]["theme"]["light"]["accent"] == "#2a55c7"


@pytest.mark.parametrize(
    "colour",
    [
        "red",
        "#fff",
        "#GGGGGG",
        "#e2531b;}body{display:none",
        "var(--x)",
        "url(https://a.test/x)",
        "rgb(0,0,0)",
        "#e2531bff",
        "",
        None,
        16777215,
    ],
)
def test_colours_are_six_digit_hex_only(signed_in, colour):
    tokens = copy.deepcopy(theme.DEFAULT)
    tokens["light"]["accent"] = colour

    assert signed_in.patch("/settings", {"theme": tokens}).status_code == 400


def test_colours_are_stored_in_lower_case(signed_in):
    tokens = copy.deepcopy(theme.DEFAULT)
    tokens["light"]["ink"] = "#161412".upper()

    response = signed_in.patch("/settings", {"theme": tokens})

    assert response.json()["draft"]["theme"]["light"]["ink"] == "#161412"
