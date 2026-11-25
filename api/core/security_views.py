"""Admin pages about the site's own security: the abuse overview (SPEC 5.13),
alerts (SPEC 10.15) and the access review (SPEC 5.11)."""

import re
from datetime import date, timedelta

from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone

from core import abuse, access_review, audit, responses
from core.authz import Level, admin_route
from core.models import Alert

DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
DIGITS = re.compile(r"[0-9]{1,3}")
ALERT_PAGE = 50
ALERT_MAX_PAGE = 100


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


def _alert(alert):
    return {
        "id": str(alert.id),
        "at": alert.created_at.isoformat(),
        "kind": alert.kind,
        "summary": alert.summary,
        "seen": alert.seen_at is not None,
    }


@admin_route(Level.SESSION)
def alert_list(request):
    """Newest first. before is the id of the last alert on the page before."""
    params = _single(request.GET, {"unseen", "before", "limit"})
    if params is None:
        return responses.bad_request()
    limit = ALERT_PAGE
    if "limit" in params:
        raw = params["limit"]
        if not DIGITS.fullmatch(raw) or not 1 <= int(raw) <= ALERT_MAX_PAGE:
            return responses.bad_request()
        limit = int(raw)
    alerts = Alert.objects.order_by("-created_at", "-id")
    if "unseen" in params:
        if params["unseen"] != "1":
            return responses.bad_request()
        alerts = alerts.filter(seen_at=None)
    if "before" in params:
        if not UUID.fullmatch(params["before"]):
            return responses.bad_request()
        last = Alert.objects.filter(id=params["before"]).first()
        if last is None:
            return responses.bad_request()
        alerts = alerts.filter(
            Q(created_at__lt=last.created_at)
            | Q(created_at=last.created_at, id__lt=last.id)
        )
    page = list(alerts[: limit + 1])
    more = len(page) > limit
    page = page[:limit]
    return JsonResponse(
        {
            "alerts": [_alert(alert) for alert in page],
            "next_before": str(page[-1].id) if more else None,
            "unseen": Alert.objects.filter(seen_at=None).count(),
        }
    )


@admin_route(Level.SESSION, methods=("POST",))
def alert_seen(request, alert_id):
    with transaction.atomic():
        alert = Alert.objects.select_for_update().filter(id=alert_id).first()
        if alert is None:
            return responses.not_found()
        if alert.seen_at is None:
            alert.seen_at = timezone.now()
            alert.save(update_fields=["seen_at"])
            audit.record("alert_seen", id=str(alert.id), kind=alert.kind)
    return JsonResponse(_alert(alert))


@admin_route(Level.SESSION)
def access(request):
    if request.GET:
        return responses.bad_request()
    return JsonResponse({"principals": access_review.review(request.admin_session)})
