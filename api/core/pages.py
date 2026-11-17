"""Page-numbered listings. Unknown or repeated query parameters are refused."""

import re

PAGE_SIZE = 25
DIGITS = re.compile(r"[0-9]{1,6}")


def requested_page(params, allowed=()):
    """The page number asked for, 1 if none, or None if the query is not valid."""
    if any(len(values) != 1 for _, values in params.lists()):
        return None
    if not {"page", *allowed}.issuperset(params):
        return None
    raw = params.get("page", "1")
    if not DIGITS.fullmatch(raw) or int(raw) < 1:
        return None
    return int(raw)


def page_of(rows, number, describe):
    """One page of a queryset or list, with the totals the admin needs."""
    count = len(rows) if isinstance(rows, list) else rows.count()
    start = (number - 1) * PAGE_SIZE
    return {
        "results": [describe(row) for row in rows[start : start + PAGE_SIZE]],
        "page": number,
        "pages": max(1, -(-count // PAGE_SIZE)),
        "count": count,
    }
