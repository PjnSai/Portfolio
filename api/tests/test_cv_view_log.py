"""The CV view log in the admin, and its retention: raw rows go after 90 days
(SPEC 5.8a (e)), counted into the day totals first so the counts survive."""

import json
from datetime import UTC, datetime, timedelta
from io import StringIO

import pytest
from django.core.management import call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import retention
from core.models import AuditLog, CvDayCount, CvView

pytestmark = pytest.mark.django_db

VERSION = "00000000-0000-4000-8000-000000000001"


def view(at=None, country="GB", agent="Browser/1.0"):
    return CvView.objects.create(
        version=VERSION, at=at or timezone.now(), country=country, user_agent=agent
    )


def days_ago(n, hour=12):
    today = timezone.now().astimezone(UTC).date()
    day = today - timedelta(days=n)
    return datetime(day.year, day.month, day.day, hour, tzinfo=UTC)


# The list


def test_the_list_is_newest_first_and_needs_a_session(signed_in, api):
    older = view(at=timezone.now() - timedelta(hours=2), country="FR")
    newer = view(country="GB")

    body = signed_in.get("/cv/views").json()

    assert [row["id"] for row in body["results"]] == [str(newer.id), str(older.id)]
    assert body["results"][0] == {
        "id": str(newer.id),
        "at": newer.at.isoformat(),
        "version": VERSION,
        "kind": "view",
        "country": "GB",
        "user_agent": "Browser/1.0",
    }
    assert (body["page"], body["pages"], body["count"]) == (1, 1, 2)


def test_the_list_is_paginated(signed_in):
    for _ in range(30):
        view()

    first = signed_in.get("/cv/views").json()
    second = signed_in.get("/cv/views", {"page": "2"}).json()

    assert (len(first["results"]), len(second["results"])) == (25, 5)
    assert first["pages"] == 2


@pytest.mark.parametrize("query", [{"page": "0"}, {"page": "x"}, {"sort": "at"}])
def test_bad_queries_are_refused(signed_in, query):
    assert signed_in.get("/cv/views", query).status_code == 400


def test_the_log_needs_a_session(api, passkey):
    assert api.get("/cv/views").status_code == 401
    assert api.get("/cv/views/days").status_code == 401


# Counts per day


def test_counts_per_day_join_the_kept_totals_and_the_recent_rows(signed_in):
    CvDayCount.objects.create(day=days_ago(200).date(), count=7)
    view(at=days_ago(2))
    view(at=days_ago(2, hour=18))
    view(at=days_ago(0))

    body = signed_in.get("/cv/views/days").json()

    assert body == {
        "days": [
            {"day": days_ago(0).date().isoformat(), "count": 1},
            {"day": days_ago(2).date().isoformat(), "count": 2},
            {"day": days_ago(200).date().isoformat(), "count": 7},
        ],
        "total": 10,
    }


def test_counts_refuse_query_strings(signed_in):
    assert signed_in.get("/cv/views/days", {"x": "1"}).status_code == 400


# Retention


def run(*args):
    out = StringIO()
    call_command("run_retention", *args, stdout=out)
    return out.getvalue()


def test_views_past_90_days_are_counted_then_removed():
    old = [view(at=days_ago(91)), view(at=days_ago(91, hour=1)), view(at=days_ago(120))]
    recent = view(at=days_ago(89))

    output = run()

    assert list(CvView.objects.values_list("id", flat=True)) == [recent.id]
    assert {c.day: c.count for c in CvDayCount.objects.all()} == {
        days_ago(91).date(): 2,
        days_ago(120).date(): 1,
    }
    assert "3 CV views past 90 days counted and removed" in output
    assert len(old) == 3


def test_only_whole_days_are_rolled_up():
    edge = view(at=days_ago(90, hour=0))

    run()

    assert CvView.objects.filter(id=edge.id).exists()
    assert CvDayCount.objects.count() == 0


def test_counts_survive_and_grow_over_runs(signed_in):
    view(at=days_ago(100))
    run()
    # A late row for a day already counted is added, not replaced.
    view(at=days_ago(100, hour=3))
    run()

    assert CvDayCount.objects.get().count == 2
    assert CvView.objects.count() == 0
    assert signed_in.get("/cv/views/days").json()["total"] == 2


def test_a_dry_run_counts_and_changes_nothing():
    view(at=days_ago(95))

    output = run("--dry-run")

    assert CvView.objects.count() == 1
    assert CvDayCount.objects.count() == 0
    assert "1 CV views past 90 days" in output
    assert AuditLog.objects.get(event="retention_run").detail["cv_views_deleted"] == 1


def test_the_old_rows_go_in_one_delete_statement():
    for n in range(5):
        view(at=days_ago(100 + n))

    with CaptureQueriesContext(connection) as queries:
        run()

    deletes = [
        q["sql"] for q in queries.captured_queries if q["sql"].startswith("DELETE")
    ]
    assert len([s for s in deletes if "cv_views" in s]) == 1


def test_the_audit_holds_counts_only():
    view(at=days_ago(100), agent="Secret Agent/9")

    run()

    entry = AuditLog.objects.get(event="retention_run")
    assert entry.detail["cv_views_deleted"] == 1
    assert "Secret Agent" not in json.dumps(entry.detail)
    assert "GB" not in json.dumps(entry.detail)


def test_the_rule_runs_under_the_job_lock(monkeypatch):
    view(at=days_ago(100))

    def busy():
        raise retention.Busy

    monkeypatch.setattr(retention, "_lock", busy)

    with pytest.raises(retention.Busy):
        retention.run()
    assert CvView.objects.count() == 1
    assert CvDayCount.objects.count() == 0


def test_the_period_is_90_days():
    assert retention.CV_VIEW_DAYS == 90
