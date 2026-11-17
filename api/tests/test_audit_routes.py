import pytest
from django.db import connection

from core import audit
from core.models import AuditLog

pytestmark = pytest.mark.django_db


@pytest.fixture
def entries(signed_in):
    """Seven publish entries on top of the sign-in the fixture recorded."""
    for n in range(7):
        audit.record("publish", n=n)
    return signed_in


def test_entries_are_listed_newest_first(entries):
    body = entries.get("/audit").json()

    seqs = [entry["seq"] for entry in body["entries"]]
    assert seqs == sorted(seqs, reverse=True)
    assert len(seqs) == AuditLog.objects.count()
    assert body["next_before"] is None
    assert set(body["entries"][0]) == {"seq", "at", "event", "actor", "detail", "hash"}


def test_entries_are_paged_by_sequence_number(entries):
    first = entries.get("/audit", {"limit": "3"}).json()
    second = entries.get(
        "/audit", {"limit": "3", "before": str(first["next_before"])}
    ).json()

    assert len(first["entries"]) == len(second["entries"]) == 3
    assert first["next_before"] == first["entries"][-1]["seq"]
    assert second["entries"][0]["seq"] == first["next_before"] - 1


def test_entries_can_be_filtered_by_event(entries):
    listed = entries.get("/audit", {"event": "login"}).json()["entries"]

    assert [entry["event"] for entry in listed] == ["login"]


@pytest.mark.parametrize(
    "params",
    [
        {"limit": "0"},
        {"limit": "101"},
        {"limit": "-1"},
        {"limit": "1.5"},
        {"limit": "١٢"},
        {"limit": " 5"},
        {"before": "0"},
        {"before": "9" * 19},
        {"event": ""},
        {"event": "x" * 61},
        {"event": "a\nb"},
        {"order": "seq"},
        {"limit": ["5", "6"]},
    ],
)
def test_bad_query_is_refused(entries, params):
    assert entries.get("/audit", params).status_code == 400


def test_listing_never_shows_secrets(entries):
    text = entries.get("/audit").content.decode()

    assert entries.cookie not in text
    assert entries.csrf not in text
    assert "127.0.0.1" not in text


def test_verify_reports_an_intact_chain(entries):
    body = entries.get("/audit/verify").json()

    assert body == {
        "ok": True,
        "entries": AuditLog.objects.count(),
        "first_bad_seq": None,
    }


def test_verify_reports_where_the_chain_breaks(entries):
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE audit_log DISABLE TRIGGER USER")
    AuditLog.objects.filter(seq=3).update(event="changed")

    body = entries.get("/audit/verify").json()

    assert body["ok"] is False
    assert body["first_bad_seq"] == 3


def test_audit_routes_are_read_only(entries):
    assert entries.post("/audit").status_code == 405
    assert entries.post("/audit/verify").status_code == 405
