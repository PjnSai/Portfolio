"""Walk the content serializers so tests cover every field, including new ones."""

import copy

from rest_framework import serializers as drf

from core import content
from core import serializers as s

MONTH = "2024-09"
URL = "https://example.test/page"


def kind_of(field):
    if isinstance(field, s.Colour):
        return "colour"
    validators = getattr(field, "validators", [])
    if s._https_url in validators:
        return "url"
    if s._month in validators:
        return "month"
    if isinstance(field, s.Text):
        return "text"
    return None


def sample(shape, fill=lambda field: "Plain text"):
    """A valid body for shape, with every free-text field set by fill(field)."""
    body = {}
    for name, field in shape().fields.items():
        body[name] = _value(field, fill)
    if issubclass(shape, s.PaletteChoice):
        # Ids must name real palettes; the defaults name the Original preset.
        body.update(
            {
                key: copy.deepcopy(content.DEFAULT_SETTINGS[key])
                for key in content.PALETTE_KEYS
            }
        )
    return body


def _value(field, fill):
    if isinstance(field, drf.ListSerializer):
        return [sample(type(field.child), fill)]
    if isinstance(field, s.Strict):
        return sample(type(field), fill)
    if isinstance(field, drf.ListField):
        return [_value(field.child, fill)]
    if isinstance(field, s.Flag):
        return True
    if isinstance(field, s.Choice):
        return next(iter(field.choices))
    if isinstance(field, s.Id):
        return None
    kind = kind_of(field)
    if kind == "url":
        return URL
    if kind == "month":
        return MONTH
    if kind == "text":
        return fill(field)
    raise AssertionError(f"No sample for {field!r}")


def text_paths(shape, prefix=()):
    """(path, field) for every free-text field, list items at index 0."""
    for name, field in shape().fields.items():
        yield from _paths(field, (*prefix, name))


def _paths(field, path):
    if isinstance(field, drf.ListSerializer):
        yield from text_paths(type(field.child), (*path, 0))
    elif isinstance(field, s.Strict):
        yield from text_paths(type(field), path)
    elif isinstance(field, drf.ListField):
        yield from _paths(field.child, (*path, 0))
    elif kind_of(field) == "text":
        yield path, field


def list_paths(shape, prefix=()):
    """(path, field) for every list with a length cap."""
    for name, field in shape().fields.items():
        path = (*prefix, name)
        if isinstance(field, (drf.ListSerializer, drf.ListField)):
            yield path, field
            child = field.child
            if isinstance(child, s.Strict):
                yield from list_paths(type(child), (*path, 0))
        elif isinstance(field, s.Strict):
            yield from list_paths(type(field), path)


def put(body, path, value):
    target = body
    for step in path[:-1]:
        target = target[step]
    target[path[-1]] = value
    return body


def get(body, path):
    for step in path:
        body = body[step]
    return body


SECTION_SHAPES = sorted(s.SECTION_SHAPES)
ITEM_SHAPES = sorted(s.ITEM_TYPES)
