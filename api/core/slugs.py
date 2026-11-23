"""Project URL slugs. A project's slug is stored the first time it is published
and never changes after, so renaming a project keeps its address. The rules
match slugify() in web/lib/public/content.ts; tests/slug_vectors.json is
checked by both test suites."""

import re
import unicodedata

MAX_LENGTH = 60
# /projects/page/ holds the list pages.
RESERVED = frozenset({"page"})
_MARKS = re.compile("[\u0300-\u036f]")
_OTHER = re.compile(r"[^a-z0-9]+")


def slugify(text):
    plain = _MARKS.sub("", unicodedata.normalize("NFKD", text or "")).lower()
    slug = _OTHER.sub("-", plain).strip("-")[:MAX_LENGTH].rstrip("-")
    return slug or "section"


def unique(title, taken):
    """The slug for `title` that is not in `taken`: a clash gets -2, -3 and so on."""
    base = slugify(title)
    slug = base
    n = 2
    while slug in taken or slug in RESERVED:
        slug = f"{base}-{n}"
        n += 1
    return slug
