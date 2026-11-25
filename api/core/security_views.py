"""Admin pages about the site's own security: the abuse overview (SPEC 5.13)."""

import re
from datetime import date, timedelta

from django.http import JsonResponse

from core import abuse, responses
from core.authz import Level, admin_route

DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _single(params, allowed):
    """The query string as one value per name, or None if a name is unknown or
    sent twice."""
    if any(len(values) != 1 for _, values in params.lists()):
        return None
    if not set(allowed).issuperset(params):
        return None
    return {name: params.get(name) for name in params}


def _day(text):
    if not DAY.fullmatch(text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


@admin_route(Level.SESSION)
def abuse_summary(request):
    params = _single(request.GET, {"from", "to", "kind"})
    if params is None:
        return responses.bad_request()
    end = _day(params["to"]) if "to" in params else abuse.today()
    start = (
        _day(params["from"])
        if "from" in params
        else (end and end - timedelta(days=abuse.DEFAULT_DAYS - 1))
    )
    if start is None or end is None or start > end:
        return responses.bad_request()
    if (end - start).days >= abuse.MAX_DAYS:
        return responses.bad_request()
    kinds = abuse.KINDS
    if "kind" in params:
        if params["kind"] not in abuse.KINDS:
            return responses.bad_request()
        kinds = (params["kind"],)
    return JsonResponse(abuse.summary(start, end, kinds))
