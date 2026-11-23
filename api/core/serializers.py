"""Input validation for admin content. Every serializer is strict: a field it
does not name is refused, never ignored, so a request cannot set ids, positions,
published copies or timestamps by adding keys."""

import re
import uuid
from urllib.parse import urlsplit

from rest_framework import serializers

from core import theme
from core.models import Media, Palette

SECTION_TYPES = (
    "hero",
    "about",
    "projects",
    "experience",
    "education",
    "skills",
    "text",
    "gallery",
    "contact",
    "links",
)

CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
LINE_BREAK = re.compile(r"[\r\n  ]")
MONTH = re.compile(r"[0-9]{4}-(0[1-9]|1[0-2])")
HEX = re.compile(r"#[0-9a-fA-F]{6}")


class Strict(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict):
            raise serializers.ValidationError({"detail": "Expected an object."})
        unknown = sorted(set(data) - set(self.fields))
        if unknown:
            raise serializers.ValidationError(
                {name: ["This field is not allowed."] for name in unknown}
            )
        return super().to_internal_value(data)


class Text(serializers.CharField):
    """A string, and only a string: numbers and lists are not turned into one."""

    def __init__(self, *, multiline=False, **kwargs):
        self.multiline = multiline
        kwargs.setdefault("trim_whitespace", not multiline)
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        value = super().to_internal_value(data)
        if CONTROL.search(value):
            raise serializers.ValidationError("Remove the hidden control characters.")
        if not self.multiline and LINE_BREAK.search(value):
            raise serializers.ValidationError("Keep this to one line.")
        return value


class Flag(serializers.BooleanField):
    """true or false only, not "yes", 1 or "false"."""

    def to_internal_value(self, data):
        if not isinstance(data, bool):
            self.fail("invalid", input=data)
        return data


class Id(serializers.UUIDField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid", value=data)
        return str(super().to_internal_value(data))


def line(max_length, required=True):
    return Text(max_length=max_length, required=required, allow_blank=not required)


def markdown(max_length):
    return Text(max_length=max_length, required=False, allow_blank=True, multiline=True)


def month(required=True):
    return Text(
        max_length=7,
        required=required,
        allow_blank=not required,
        validators=[_month],
    )


def _month(value):
    if value and not MONTH.fullmatch(value):
        raise serializers.ValidationError("Use the form YYYY-MM, for example 2024-09.")


def _https_url(value):
    try:
        parts = urlsplit(value)
    except ValueError:
        parts = None
    if (
        parts is None
        or parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or any(c.isspace() for c in value)
    ):
        raise serializers.ValidationError("Use a full https:// address.")


# Requests


class NewSection(Strict):
    type = serializers.ChoiceField(choices=SECTION_TYPES)
    title = line(80)


class SectionContent(Strict):
    title = line(80)
    body = markdown(20000)


class Visibility(Strict):
    visible = Flag()


class Order(Strict):
    ids = serializers.ListField(child=Id(), max_length=1000)


class ItemBody(Strict):
    data = serializers.DictField()


class Publish(Strict):
    confirm = Flag(default=False)


# Shared pieces


class Choice(serializers.ChoiceField):
    """One of a fixed set of words; nothing else is turned into one."""

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid_choice", input=data)
        return super().to_internal_value(data)


class Colour(serializers.CharField):
    """A colour token: #RRGGBB and nothing else, so no CSS can ride along."""

    def __init__(self, **kwargs):
        super().__init__(max_length=7, **kwargs)

    def to_internal_value(self, data):
        if not isinstance(data, str) or not HEX.fullmatch(data):
            raise serializers.ValidationError("Use a colour like #1A2B3C.")
        return data.upper()


def tags(max_items, max_length=40):
    return serializers.ListField(
        child=line(max_length), max_length=max_items, default=list, validators=[_once]
    )


def _once(values):
    seen = {value.casefold() for value in values}
    if len(seen) != len(values):
        raise serializers.ValidationError("Each entry only once.")


class ImageSlot(Strict):
    """An image from the media library (or a slot still waiting for one)."""

    media = Id(allow_null=True, default=None)
    alt = line(300)
    caption = Text(max_length=300, allow_blank=True, default="")

    def validate_media(self, value):
        if value and not Media.objects.filter(id=value, trashed_at=None).exists():
            raise serializers.ValidationError("That image is not in the media library.")
        return value


class MediaAlt(Strict):
    alt = line(300)


# Section drafts, one shape per type


class Hero(SectionContent):
    body = markdown(1000)
    name = line(80, required=False)
    role = line(120, required=False)
    availability = line(160, required=False)


class About(SectionContent):
    location = line(80, required=False)
    photo = ImageSlot(required=False, allow_null=True)


SECTION_SHAPES = {
    kind: {"hero": Hero, "about": About}.get(kind, SectionContent)
    for kind in SECTION_TYPES
}


# Items, one serializer per section type that holds items

STATUSES = ("live", "demo", "local", "in_progress")
CARD_COLOURS = ("orange", "blue", "pink", "olive", "yellow", "ink")
LINK_KINDS = ("demo", "repository", "other")


class ProjectField(Strict):
    label = line(60)
    value = line(300)


class ProjectLink(Strict):
    kind = Choice(choices=LINK_KINDS)
    label = line(60)
    url = Text(max_length=500, validators=[_https_url])


class Project(Strict):
    title = line(120)
    summary = markdown(500)
    body = markdown(20000)
    status = Choice(choices=STATUSES, default="in_progress")
    created = month(required=False)
    category = line(40, required=False)
    colour = Choice(choices=CARD_COLOURS, default="orange")
    tags = tags(30)
    links = ProjectLink(many=True, max_length=10, default=list)
    fields = ProjectField(many=True, max_length=20, default=list)
    images = ImageSlot(many=True, max_length=8, default=list)


class Dated(Strict):
    start = month()
    end = month(required=False)
    summary = markdown(5000)

    def validate(self, attrs):
        end = attrs.get("end")
        if end and end < attrs["start"]:
            raise serializers.ValidationError({"end": ["End is before the start."]})
        return attrs


class Experience(Dated):
    organisation = line(120)
    role = line(120)
    location = line(120, required=False)
    tags = tags(20)


class Education(Dated):
    institution = line(120)
    qualification = line(120)
    grade = line(60, required=False)


class SkillGroup(Strict):
    name = line(80)
    skills = serializers.ListField(child=line(60), max_length=50, validators=[_once])


class Link(Strict):
    label = line(60)
    url = Text(max_length=500, validators=[_https_url])


ITEM_TYPES = {
    "projects": Project,
    "experience": Experience,
    "education": Education,
    "skills": SkillGroup,
    "gallery": ImageSlot,
    "links": Link,
}


# Site settings

LAYOUTS = ("ring", "vertical", "stack", "train")
SEO_PAGES = ("home", "projects", "privacy", "security", "how_built")


class PageSeo(Strict):
    title = line(70, required=False)
    description = line(160, required=False)


class Seo(Strict):
    home = PageSeo(required=False)
    projects = PageSeo(required=False)
    privacy = PageSeo(required=False)
    security = PageSeo(required=False)
    how_built = PageSeo(required=False)


# Palettes

PALETTE_MODES = ("fixed", "rotate", "pick")
# Five presets and at most twelve custom palettes.
MAX_PALETTES = 17

Slots = type(
    "Slots",
    (Strict,),
    {
        "__doc__": "Every colour slot of one mode; none may be left out.",
        **{slot: Colour() for slot in theme.SLOTS},
    },
)


class PaletteBody(Strict):
    name = line(60)
    light = Slots()
    dark = Slots()

    def validate(self, attrs):
        problems = {
            mode: found
            for mode in theme.MODES
            if (found := theme.failures(mode, attrs[mode]))
        }
        if problems:
            raise serializers.ValidationError(problems)
        return attrs


class Duplicate(Strict):
    name = line(60, required=False)


class PaletteChoice(Strict):
    """Which palettes the public site uses, and how visitors get one."""

    palette_mode = Choice(choices=PALETTE_MODES)
    default_palette_id = Id()
    enabled_palette_ids = serializers.ListField(
        child=Id(), min_length=1, max_length=MAX_PALETTES, validators=[_once]
    )

    def validate(self, attrs):
        enabled = attrs["enabled_palette_ids"]
        if attrs["default_palette_id"] not in enabled:
            raise serializers.ValidationError(
                {"default_palette_id": ["The default must be one of the enabled."]}
            )
        live = {
            str(found)
            for found in Palette.objects.filter(
                id__in=enabled, trashed_at=None
            ).values_list("id", flat=True)
        }
        if set(enabled) - live:
            raise serializers.ValidationError(
                {"enabled_palette_ids": ["Each must be a palette that exists."]}
            )
        return attrs


class Settings(PaletteChoice):
    title = line(80)
    description = line(300, required=False)
    contact_form = Flag()
    showcase_layout = Choice(choices=LAYOUTS)
    layout_switcher = Flag()
    seo = Seo(required=False)
    social_image = ImageSlot(required=False, allow_null=True)


class InboxStatus(Strict):
    status = serializers.ChoiceField(
        choices=["new", "read", "replied", "archived", "spam"]
    )


class InboxNote(Strict):
    text = Text(multiline=True, trim_whitespace=True, max_length=2000)


class InboxResponse(Strict):
    text = Text(
        multiline=True,
        trim_whitespace=True,
        max_length=2000,
        required=False,
        allow_blank=True,
    )


class InboxKeep(Strict):
    kept = Flag()


class Retention(Strict):
    spam_days = serializers.IntegerField(min_value=1, max_value=3650)
    message_days = serializers.IntegerField(min_value=1, max_value=3650)

    def to_internal_value(self, data):
        # Whole numbers only: not "30", 30.5 or true.
        for name in ("spam_days", "message_days"):
            value = data.get(name) if isinstance(data, dict) else None
            if isinstance(value, bool) or not isinstance(value, int):
                if name in data:
                    raise serializers.ValidationError({name: ["Enter a whole number."]})
        return super().to_internal_value(data)


class Nothing(Strict):
    """A request that takes no fields."""


def as_json(value):
    """Validated data as plain dicts and lists, ready for a JSON column."""
    if isinstance(value, dict):
        return {key: as_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [as_json(item) for item in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    return value
