"""Input validation for admin content. Every serializer is strict: a field it
does not name is refused, never ignored, so a request cannot set ids, positions,
published copies or timestamps by adding keys."""

import re
import uuid
from urllib.parse import urlsplit

from rest_framework import serializers

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


# Items, one serializer per section type that holds items


class ProjectField(Strict):
    label = line(60)
    value = line(300)


class Project(Strict):
    title = line(120)
    summary = markdown(500)
    body = markdown(20000)
    fields = ProjectField(many=True, required=False, max_length=20)


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


class Education(Dated):
    institution = line(120)
    qualification = line(120)


class SkillGroup(Strict):
    name = line(80)
    skills = serializers.ListField(child=line(60), max_length=50)


class GalleryImage(Strict):
    alt = line(300)
    caption = line(300, required=False)


class Link(Strict):
    label = line(60)
    url = Text(max_length=500, validators=[_https_url])


ITEM_TYPES = {
    "projects": Project,
    "experience": Experience,
    "education": Education,
    "skills": SkillGroup,
    "gallery": GalleryImage,
    "links": Link,
}


def as_json(value):
    """Validated data as plain dicts and lists, ready for a JSON column."""
    if isinstance(value, dict):
        return {key: as_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [as_json(item) for item in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    return value
