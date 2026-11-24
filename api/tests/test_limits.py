"""Contact limits the owner can change, under /api/v1/admin/limits."""

import json
from datetime import timedelta

import pytest

from core import admin_urls, audit, limits, ratelimit, serializers, sessions, vital
from core.authz import Level
from core.models import AuditLog, SiteSettings
from tests import turnstile as fake
from tests.test_contact import stored, submit
from tests.test_contact_migrations import at_latest  # noqa: F401

pytestmark = pytest.mark.django_db

DEFAULTS = {
    "human_daily_cap": 25,
    "spam_daily_cap": 20,
    "per_address_per_hour": 5,
    "per_email_per_day": 3,
    "min_seconds": 3,
    "max_links": 2,
    "spam_threshold": 100,
}
BOUNDS = {
    "human_daily_cap": (1, 200),
    "spam_daily_cap": (0, 200),
    "per_address_per_hour": (1, 50),
    "per_email_per_day": (1, 20),
    "min_seconds": (0, 30),
    "max_links": (0, 10),
    "spam_threshold": (50, 100),
}


@pytest.fixture(autouse=True)
def fresh_stand_in():
    fake.spent.clear()
    fake.asked.clear()


def values(api):
    body = api.get("/limits").json()
    return {name: item["value"] for name, item in body["editable"].items()}


def limit_events():
    return list(AuditLog.objects.filter(event="limits_changed").order_by("seq"))


# Reading


def test_a_plain_session_can_read_the_limits(signed_in):
    response = signed_in.get("/limits")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"editable", "fixed"}
    for name, item in body["editable"].items():
        assert item == {
            "value": DEFAULTS[name],
            "default": DEFAULTS[name],
            "min": BOUNDS[name][0],
            "max": BOUNDS[name][1],
        }


def test_defaults_apply_with_no_settings_row(signed_in):
    assert not SiteSettings.objects.exists()

    assert values(signed_in) == DEFAULTS
    assert limits.effective() == DEFAULTS
    assert not SiteSettings.objects.exists()


def test_the_defaults_come_from_settings(signed_in, settings):
    settings.CONTACT_PER_EMAIL_PER_DAY = 4

    assert values(signed_in)["per_email_per_day"] == 4


def test_the_route_needs_a_session_to_read_and_elevation_to_change():
    view = {str(p.pattern): p.callback for p in admin_urls.urlpatterns}
    assert view["limits"].admin_levels == {
        "GET": Level.SESSION,
        "PATCH": Level.ELEVATED,
    }


# Fixed limits


def fixed(api):
    return {row["name"]: row for row in api.get("/limits").json()["fixed"]}


def test_the_fixed_limits_are_listed_with_their_current_values(signed_in):
    from django.conf import settings

    rows = fixed(signed_in)

    assert {name: row["value"] for name, row in rows.items()} == {
        "public_requests_per_minute": settings.PUBLIC_REQUESTS_PER_MINUTE,
        "admin_requests_per_minute": settings.ADMIN_REQUESTS_PER_MINUTE,
        "sign_in_failures_per_client": settings.LOGIN_MAX_FAILURES,
        "sign_in_failures_overall": settings.LOGIN_GLOBAL_MAX_FAILURES,
        "sign_in_failure_window": ratelimit.FAILURE_WINDOW // 60,
        "sign_in_lockout": ratelimit.COOL_DOWN // timedelta(minutes=1),
        "session_idle_timeout": sessions.IDLE // timedelta(minutes=1),
        "session_absolute_timeout": sessions.ABSOLUTE // timedelta(minutes=1),
        "passkey_confirmation_lasts": sessions.ELEVATION // timedelta(minutes=1),
        "vital_action_wait": vital.DELAY // timedelta(minutes=1),
    }
    assert rows["vital_action_wait"] == {
        "name": "vital_action_wait",
        "value": 1440,
        "unit": "minutes",
    }


def test_the_fixed_limits_are_read_from_the_real_settings_not_copied(
    signed_in, settings, monkeypatch
):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 77
    settings.LOGIN_MAX_FAILURES = 9
    monkeypatch.setattr(sessions, "ABSOLUTE", timedelta(hours=8, minutes=1))
    monkeypatch.setattr(vital, "DELAY", timedelta(hours=30))

    rows = fixed(signed_in)

    assert rows["public_requests_per_minute"]["value"] == 77
    assert rows["sign_in_failures_per_client"]["value"] == 9
    assert rows["session_absolute_timeout"]["value"] == 481
    assert rows["vital_action_wait"]["value"] == 1800


def test_fixed_limits_cannot_be_changed(elevated):
    response = elevated.patch("/limits", {"public_requests_per_minute": 5})

    assert response.status_code == 400
    assert limit_events() == []


# Changing


def test_an_elevated_session_can_change_a_limit(elevated):
    response = elevated.patch("/limits", {"per_email_per_day": 1})

    assert response.status_code == 200
    assert response.json()["editable"]["per_email_per_day"]["value"] == 1
    assert values(elevated) == {**DEFAULTS, "per_email_per_day": 1}


def test_changing_needs_a_confirmed_passkey_and_changes_nothing(signed_in):
    before = AuditLog.objects.count()

    response = signed_in.patch("/limits", {"per_email_per_day": 1})

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert values(signed_in) == DEFAULTS
    assert AuditLog.objects.count() == before


def test_several_at_once_and_the_rest_are_left(elevated):
    elevated.patch("/limits", {"human_daily_cap": 40, "max_links": 4})
    elevated.patch("/limits", {"spam_threshold": 80})

    assert values(elevated) == {
        **DEFAULTS,
        "human_daily_cap": 40,
        "max_links": 4,
        "spam_threshold": 80,
    }


EDGES = [
    pytest.param(name, value, id=f"{name}={value}")
    for name, (low, high) in BOUNDS.items()
    for value in (low, high)
]
PAST = [
    pytest.param(name, value, id=f"{name}={value}")
    for name, (low, high) in BOUNDS.items()
    for value in (low - 1, high + 1)
]


@pytest.mark.parametrize("name,value", EDGES)
def test_both_edges_are_allowed(elevated, name, value):
    response = elevated.patch("/limits", {name: value})

    assert response.status_code == 200
    assert values(elevated)[name] == value


@pytest.mark.parametrize("name,value", PAST)
def test_one_past_each_edge_is_refused_and_changes_nothing(elevated, name, value):
    response = elevated.patch("/limits", {name: value})

    assert response.status_code == 400
    assert values(elevated) == DEFAULTS
    assert limit_events() == []


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"per_email_per_day": "2"},
        {"per_email_per_day": 2.0},
        {"per_email_per_day": 2.5},
        {"per_email_per_day": True},
        {"per_email_per_day": None},
        {"per_email_per_day": [2]},
        {"per_email_per_day": 2, "unknown": 1},
        {"retention_spam_days": 7},
    ],
)
def test_whole_numbers_only_and_known_names_only(elevated, body):
    response = elevated.patch("/limits", body)

    assert response.status_code == 400
    assert values(elevated) == DEFAULTS


def test_the_serializer_and_the_constants_agree():
    fields = serializers.Limits().fields

    assert set(fields) == set(limits.EDITABLE) == set(BOUNDS)
    for name, limit in limits.EDITABLE.items():
        assert (fields[name].min_value, fields[name].max_value) == (
            limit.low,
            limit.high,
        )
        assert (limit.low, limit.high) == BOUNDS[name]
        assert hasattr(SiteSettings, limit.field)
        assert limit.low <= limits.defaults()[name] <= limit.high
    assert limits.defaults() == DEFAULTS


# Audit


def test_one_audit_entry_per_change_with_names_and_numbers_only(elevated):
    elevated.patch("/limits", {"per_email_per_day": 1, "min_seconds": 5})

    (entry,) = limit_events()
    assert entry.detail == {
        "changes": {
            "per_email_per_day": {"old": 3, "new": 1},
            "min_seconds": {"old": 3, "new": 5},
        }
    }
    for change in entry.detail["changes"].values():
        assert all(type(n) is int for n in change.values())
    assert audit.verify_chain().ok


def test_saving_the_same_values_writes_no_audit_entry(elevated):
    response = elevated.patch("/limits", {"per_email_per_day": 3})

    assert response.status_code == 200
    assert limit_events() == []


def test_the_audit_entry_lists_only_what_changed(elevated):
    elevated.patch("/limits", {"per_email_per_day": 3, "max_links": 1})

    (entry,) = limit_events()
    assert entry.detail == {"changes": {"max_links": {"old": 2, "new": 1}}}


def test_a_change_and_its_audit_entry_stand_or_fall_together(elevated, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(audit, "record", broken)

    with pytest.raises(RuntimeError):
        elevated.patch("/limits", {"per_email_per_day": 1})

    monkeypatch.undo()
    assert limits.effective() == DEFAULTS


# Never public


def test_edited_limits_never_appear_in_the_public_site(elevated, client):
    elevated.patch(
        "/limits", {"per_email_per_day": 17, "human_daily_cap": 173, "max_links": 9}
    )

    body = client.get("/api/v1/site", secure=True).content.decode()

    for name in (*limits.EDITABLE, *limits.FIELDS, "limits"):
        assert name not in body
    assert "173" not in body
    published = json.dumps(SiteSettings.objects.values("draft", "published").get())
    assert "173" not in published


# The form uses the values in force


def test_the_form_honours_an_edited_per_email_limit(elevated):
    elevated.patch("/limits", {"per_email_per_day": 1})

    assert submit(ip="198.51.100.1", email="one@example.com").status_code == 201
    assert submit(ip="198.51.100.2", email="one@example.com").status_code == 429


def test_the_form_honours_an_edited_address_limit(elevated):
    elevated.patch("/limits", {"per_address_per_hour": 1})

    assert submit(ip="198.51.100.1").status_code == 201
    assert submit(ip="198.51.100.1").status_code == 429


def test_the_form_honours_an_edited_daily_cap(elevated):
    elevated.patch("/limits", {"human_daily_cap": 1})

    assert submit(ip="198.51.100.1").status_code == 201
    assert submit(ip="198.51.100.2").status_code == 429


def test_the_form_honours_an_edited_spam_cap(elevated):
    elevated.patch("/limits", {"spam_daily_cap": 0})

    assert submit(ip="198.51.100.1", website="x").status_code == 201
    assert stored() == []


def test_the_form_honours_an_edited_minimum_time(elevated):
    elevated.patch("/limits", {"min_seconds": 0})

    submit(age=0)

    assert [m.status for m in stored()] == ["new"]


def test_the_form_honours_an_edited_link_limit(elevated):
    elevated.patch("/limits", {"max_links": 0})

    submit(body="Here is my work: https://example.org/portfolio, thank you.")

    assert [m.status for m in stored()] == ["spam"]


def test_the_form_honours_an_edited_threshold(elevated):
    elevated.patch("/limits", {"spam_threshold": 50})

    # Two links score 40 and one advertising word 25: 65 is now spam.
    submit(body="See https://a.example and https://b.example for casino offers.")

    (message,) = stored()
    assert (message.spam_score, message.status) == (65, "spam")


def test_a_change_applies_to_the_next_submission(elevated):
    assert submit(ip="198.51.100.1", email="two@example.com").status_code == 201
    elevated.patch("/limits", {"per_email_per_day": 1})

    assert submit(ip="198.51.100.2", email="two@example.com").status_code == 429


# Migration 0017


def test_0017_adds_empty_limit_fields_and_reverses(at_latest):  # noqa: F811
    from tests.test_contact_migrations import columns, migrate, settle

    apps = migrate([("core", "0016_contact_spam_at")])
    assert not set(limits.FIELDS) & columns("site_settings")
    row = apps.get_model("core", "SiteSettings").objects.create()
    settle()

    apps = migrate([("core", "0017_contact_limits")])

    assert set(limits.FIELDS) <= columns("site_settings")
    found = apps.get_model("core", "SiteSettings").objects.get(id=row.id)
    assert all(getattr(found, field) is None for field in limits.FIELDS)
    found.delete()
    settle()

    migrate([("core", "0016_contact_spam_at")])

    assert not set(limits.FIELDS) & columns("site_settings")
