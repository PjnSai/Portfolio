"""Find contact details that should not go on the public site (SPEC 9): email
addresses, phone numbers and UK postcodes. This only warns; the owner decides."""

import re

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
# A run that starts with + or 0 and is mostly digits, spaces, dashes and brackets.
PHONE = re.compile(r"(?<![\w.])(?:\+|0)[\d \-()]{8,20}\d(?![\w.])")
POSTCODE = re.compile(
    r"\b(?:[A-Z]{1,2}[0-9][A-Z0-9]?|GIR) ?[0-9][A-Z]{2}\b", re.IGNORECASE
)


def _phones(text):
    for match in PHONE.finditer(text):
        digits = sum(c.isdigit() for c in match.group())
        if 10 <= digits <= 13:
            yield match.group().strip()


def _found(text):
    for kind, matches in (
        ("email", (m.group() for m in EMAIL.finditer(text))),
        ("phone", _phones(EMAIL.sub(" ", text))),
        ("postcode", (m.group() for m in POSTCODE.finditer(EMAIL.sub(" ", text)))),
    ):
        for match in matches:
            yield kind, match


def _strings(value, where):
    if isinstance(value, str):
        yield where, value
    elif isinstance(value, dict):
        for key, inner in value.items():
            yield from _strings(inner, f"{where} {key}".strip())
    elif isinstance(value, list):
        for number, inner in enumerate(value, start=1):
            yield from _strings(inner, f"{where} {number}".strip())


def scan(data, prefix=""):
    """[{where, kind, text}] for every match in every string of data."""
    return [
        {"where": where, "kind": kind, "text": text}
        for where, value in _strings(data, prefix)
        for kind, text in _found(value)
    ]
