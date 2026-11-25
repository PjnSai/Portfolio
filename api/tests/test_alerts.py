"""Alerts: each trigger, the daily cap, no repeat inside a window, no personal
data, and a failing database notifier never breaking what caused it."""

import json
import logging
from datetime import timedelta

import pytest
import redis
from django.db import DatabaseError
from django.http import HttpResponse
from django.test import RequestFactory
from django.utils import timezone

from core import abuse, alerts, cache, notify
from core.models import AbuseCount, Alert, AuditLog, PendingAction
from tests.authenticator import SoftAuthenticator
from tests.conftest import mature, new_message
from tests.notifiers import Recorder
from tests.test_contact import ADDRESS, submit
from tests.test_login import bootstrap
from tests.test_owner import recover
from tests.test_vital import reconfirm, request_passkey

pytestmark = pytest.mark.django_db

EVIL = "https://evil.test"


def kinds():
    return list(Alert.objects.order_by("created_at").values_list("kind", flat=True))


def request_delete(api):
    message = new_message()
    return api.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "message", "id": str(message.id)},
        },
    )


def public_read(client):
    return client.get(
        "/api/v1/site", secure=True, headers={"Cf-Connecting-Ip": ADDRESS}
    )


@pytest.fixture
def few(settings):
    """Small thresholds, and no sign-in cool-down to get in the way."""
    settings.ALERT_SIGN_IN_FAILURES = 3
    settings.ALERT_RATE_LIMITED = 3
    settings.ALERT_SERVER_ERRORS = 3
    settings.LOGIN_MAX_FAILURES = 100
    settings.LOGIN_GLOBAL_MAX_FAILURES = 100
    return settings


def server_errors(n):
    middleware = alerts.ServerErrorMiddleware(lambda request: HttpResponse(status=503))
    for _ in range(n):
        middleware(RequestFactory().get("/api/v1/site"))


# Settings


def test_the_database_notifier_is_registered_first_and_the_others_stay(monkeypatch):
    import importlib

    import config.settings as real

    monkeypatch.setenv("NOTIFIERS", "core.notify.LogNotifier")
    try:
        importlib.reload(real)
        assert real.NOTIFIERS == [
            "core.notify.DatabaseNotifier",
            "core.notify.LogNotifier",
        ]
    finally:
        monkeypatch.delenv("NOTIFIERS")
        importlib.reload(real)
    assert real.NOTIFIERS == ["core.notify.DatabaseNotifier"]
    assert real.MIDDLEWARE[1] == "core.alerts.ServerErrorMiddleware"


def test_the_values_in_force():
    from config import settings as real

    assert (real.ALERT_SIGN_IN_FAILURES, real.ALERT_SIGN_IN_WINDOW) == (5, 900)
    assert (real.ALERT_RATE_LIMITED, real.ALERT_RATE_LIMITED_WINDOW) == (100, 600)
    assert (real.ALERT_SERVER_ERRORS, real.ALERT_SERVER_ERRORS_WINDOW) == (20, 300)
    assert real.ALERT_DAILY_CAP == 5


# Triggers


def test_repeated_failed_sign_ins_raise_one_alert(api, passkey, few):
    for _ in range(2):
        api.login(passkey, origin=EVIL)
    assert kinds() == []

    api.login(passkey, origin=EVIL)
    api.login(passkey, origin=EVIL)

    assert kinds() == [alerts.FAILED_SIGN_INS]
    assert Alert.objects.get().summary == (
        "3 failed sign-ins or passkey confirmations in 15 minutes."
    )
    assert (alerts.FAILED_SIGN_INS, {"count": 3, "minutes": 15}) in Recorder.sent


def test_failed_passkey_confirmations_count_with_failed_sign_ins(
    signed_in, passkey, few
):
    signed_in.elevate(passkey, origin=EVIL)
    signed_in.elevate(passkey, origin=EVIL)
    assert kinds() == []

    signed_in.elevate(passkey, origin=EVIL)

    assert kinds() == [alerts.FAILED_SIGN_INS]


def test_a_lockout_is_an_alert_of_the_same_kind(api, passkey, settings):
    settings.LOGIN_MAX_FAILURES = 2
    settings.ALERT_SIGN_IN_FAILURES = 2

    api.login(passkey, origin=EVIL)
    api.login(passkey, origin=EVIL)

    assert kinds() == [alerts.FAILED_SIGN_INS]
    assert ("lockout", {"scope": "login"}) in Recorder.sent


def test_a_lockout_alone_says_sign_in_was_paused(api, passkey, settings):
    settings.LOGIN_MAX_FAILURES = 2

    api.login(passkey, origin=EVIL)
    api.login(passkey, origin=EVIL)

    alert = Alert.objects.get()
    assert alert.kind == alerts.FAILED_SIGN_INS
    assert alert.summary == "Sign-in was paused for one client after repeated failures."


def test_a_passkey_added_through_a_vital_action_raises_an_alert(elevated, passkey):
    action_id = request_passkey(elevated)
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options").json()

    elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options)},
    )

    assert kinds() == [alerts.VITAL_ACTION_REQUESTED, alerts.PASSKEY_ADDED]
    assert (
        Alert.objects.get(kind=alerts.PASSKEY_ADDED).summary == "A passkey was added."
    )


def test_the_first_passkey_raises_an_alert(api, db):
    assert bootstrap(api, SoftAuthenticator()).status_code == 201

    alert = Alert.objects.get()
    assert (alert.kind, alert.summary) == (
        alerts.PASSKEY_ADDED,
        "A passkey was added as the first passkey.",
    )


def test_a_passkey_added_with_the_recovery_key_raises_an_alert(api, new_api, db):
    response = bootstrap(api, SoftAuthenticator())
    Alert.objects.all().delete()

    recovered = recover(new_api(), response.json()["recovery_key"], SoftAuthenticator())

    assert recovered.status_code == 201
    assert kinds() == [alerts.PASSKEY_ADDED]
    assert "recovery key was used" in Alert.objects.get().summary


def test_a_vital_action_request_raises_an_alert(elevated):
    assert request_delete(elevated).status_code == 201

    alert = Alert.objects.get()
    assert alert.kind == alerts.VITAL_ACTION_REQUESTED
    assert alert.summary == (
        "A vital action was requested: delete something for good. "
        "Cancel it if it was not you."
    )
    assert alert.seen_at is None


def test_a_rate_limit_storm_raises_one_alert(client, few):
    few.PUBLIC_REQUESTS_PER_MINUTE = 0
    for _ in range(2):
        public_read(client)
    assert kinds() == []

    for _ in range(5):
        assert public_read(client).status_code == 429

    assert kinds() == [alerts.RATE_LIMIT_STORM]
    assert Alert.objects.get().summary == (
        "3 requests refused by a rate limit in 10 minutes."
    )


def test_contact_rate_limits_feed_the_storm_too(few):
    few.CONTACT_PER_ADDRESS_PER_HOUR = 1
    submit()

    for _ in range(3):
        assert submit().status_code == 429

    assert kinds() == [alerts.RATE_LIMIT_STORM]


def test_a_spike_of_server_errors_raises_one_alert(few):
    server_errors(2)
    assert kinds() == []

    server_errors(5)

    assert kinds() == [alerts.ERROR_SPIKE]
    assert Alert.objects.get().summary == "3 server errors in 5 minutes."


def test_server_errors_from_real_requests_are_counted(client, few):
    for _ in range(3):
        response = client.post(
            "/api/v1/contact",
            json.dumps(
                {
                    "name": "A",
                    "email": "a@example.com",
                    "body": "Hello there, a message.",
                    "turnstile": "unavailable",
                }
            ),
            content_type="application/json",
            secure=True,
            headers={"Origin": "https://portfolio.test", "Sec-Fetch-Site": "same-site"},
        )
        assert response.status_code == 503

    assert kinds() == [alerts.ERROR_SPIKE]


def test_other_answers_are_not_counted_as_errors(client, few):
    for _ in range(5):
        client.get("/api/v1/status", secure=True)
        client.get("/api/v1/missing", secure=True)

    assert kinds() == []
    assert not [key for key in cache.client().keys("alert:error_spike:*")]


def test_notices_that_are_not_alerts_record_nothing(elevated):
    elevated.post("/sessions/revoke-all")

    assert ("sessions_revoked", {"count": 1}) in Recorder.sent
    assert kinds() == []


# No repeat inside a window, and the daily cap


def test_a_threshold_alert_does_not_repeat_inside_its_window(few, monkeypatch):
    server_errors(3)
    # The next window of the counter, but still inside the alert's own window.
    monkeypatch.setattr(alerts.time, "time", lambda: 10**10)
    server_errors(3)

    assert kinds() == [alerts.ERROR_SPIKE]
    sent = [event for event, _ in Recorder.sent if event == alerts.ERROR_SPIKE]
    assert len(sent) == 1


def test_a_threshold_alert_repeats_once_its_window_has_passed(few, monkeypatch):
    server_errors(3)
    Alert.objects.update(created_at=timezone.now() - timedelta(minutes=6))
    monkeypatch.setattr(alerts.time, "time", lambda: 10**10)

    server_errors(3)

    assert kinds() == [alerts.ERROR_SPIKE, alerts.ERROR_SPIKE]


def test_each_kind_is_capped_per_day_but_the_action_still_goes_ahead(
    elevated, settings
):
    settings.ALERT_DAILY_CAP = 2

    statuses = [request_delete(elevated).status_code for _ in range(3)]

    assert statuses == [201, 201, 201]
    assert PendingAction.objects.count() == 3
    assert kinds() == [alerts.VITAL_ACTION_REQUESTED] * 2
    notices = [e for e, _ in Recorder.sent if e == "vital_action_requested"]
    assert len(notices) == 3


def test_the_cap_is_per_kind_and_per_day(elevated, settings, few):
    settings.ALERT_DAILY_CAP = 1
    yesterday = timezone.now() - timedelta(days=1, hours=1)
    Alert.objects.create(kind=alerts.ERROR_SPIKE, summary="x", created_at=yesterday)
    request_delete(elevated)
    request_delete(elevated)

    server_errors(3)

    assert sorted(kinds()) == sorted(
        [alerts.ERROR_SPIKE, alerts.VITAL_ACTION_REQUESTED, alerts.ERROR_SPIKE]
    )


def test_a_threshold_alert_over_the_cap_is_not_sent_anywhere(few):
    few.ALERT_DAILY_CAP = 0

    server_errors(3)

    assert kinds() == []
    assert alerts.ERROR_SPIKE not in [event for event, _ in Recorder.sent]


# No personal data


def test_no_alert_or_alert_log_holds_personal_data(
    api, new_api, elevated, passkey, few, caplog
):
    caplog.set_level(logging.INFO)
    few.PUBLIC_REQUESTS_PER_MINUTE = 0
    few.CONTACT_PER_ADDRESS_PER_HOUR = 0
    for _ in range(3):
        new_api().login(passkey, origin=EVIL)
        submit(email="person@example.com", body="Private words from a visitor.")
    request_delete(elevated)
    server_errors(3)

    assert set(kinds()) == {
        alerts.FAILED_SIGN_INS,
        alerts.RATE_LIMIT_STORM,
        alerts.VITAL_ACTION_REQUESTED,
        alerts.ERROR_SPIKE,
    }
    stored = json.dumps(list(Alert.objects.values()), default=str)
    listed = elevated.get("/alerts").content.decode()
    logged = "\n".join(
        r.getMessage()
        for r in caplog.records
        if r.name in ("core.alerts", "core.notify")
    )
    for text in (stored, listed, logged):
        for private in (
            "person@example.com",
            "@",
            "Private words",
            ADDRESS,
            "127.0.0.1",
            "Test key",
            elevated.cookie,
            elevated.csrf,
        ):
            assert private not in text


def test_a_summary_takes_only_numbers_and_known_values():
    text = alerts.summary(
        alerts.VITAL_ACTION_REQUESTED,
        {"kind": "someone@example.com", "id": "x", "cancel_path": "/p"},
    )
    assert text == (
        "A vital action was requested: a change. Cancel it if it was not you."
    )
    text = alerts.summary(alerts.ERROR_SPIKE, {"count": "203.0.113.7", "minutes": True})
    assert text == "0 server errors in 0 minutes."
    text = alerts.summary(alerts.PASSKEY_ADDED, {"name": "Pujan's phone", "via": "x"})
    assert text == "A passkey was added."


def test_the_table_has_no_room_for_personal_data():
    names = {field.name for field in Alert._meta.get_fields()}

    assert names == {"id", "created_at", "kind", "summary", "seen_at"}


# A failing database notifier


def _recording_breaks(monkeypatch):
    def broken(*args, **kwargs):
        raise DatabaseError("down")

    monkeypatch.setattr(Alert.objects, "create", broken)


def test_a_vital_action_goes_ahead_when_its_alert_cannot_be_recorded(
    elevated, monkeypatch, caplog
):
    _recording_breaks(monkeypatch)
    caplog.set_level(logging.WARNING, logger="core.notify")

    response = request_delete(elevated)

    assert response.status_code == 201
    assert PendingAction.objects.count() == 1
    assert AuditLog.objects.filter(event="vital_action_requested").exists()
    assert "vital_action_requested" in [e for e, _ in Recorder.sent]
    assert "notice vital_action_requested not recorded: DatabaseError" in caplog.text
    assert (
        AbuseCount.objects.get(day=abuse.today(), kind=abuse.NOTICE_FAILED).count == 1
    )


def test_a_new_passkey_is_kept_when_its_alert_cannot_be_recorded(
    elevated, passkey, monkeypatch
):
    action_id = request_passkey(elevated)
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options").json()
    _recording_breaks(monkeypatch)

    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options)},
    )

    assert response.status_code == 200
    assert (
        AbuseCount.objects.get(day=abuse.today(), kind=abuse.NOTICE_FAILED).count == 1
    )


def test_a_failed_sign_in_answers_the_same_when_alerting_fails(
    api, passkey, few, monkeypatch
):
    _recording_breaks(monkeypatch)
    statuses = [api.login(passkey, origin=EVIL).status_code for _ in range(3)]

    assert statuses == [401, 401, 401]
    assert api.login(passkey).status_code == 200


def test_alerting_with_redis_down_never_raises(few, monkeypatch, caplog):
    def down():
        raise redis.ConnectionError("down")

    monkeypatch.setattr(cache, "client", down)

    alerts.server_error()
    alerts.observe(abuse.RATE_LIMITED)

    assert "alert count failed kind=error_spike error=ConnectionError" in caplog.text
    assert kinds() == []


def test_an_alert_is_still_sent_when_the_database_check_fails(few, monkeypatch):
    def broken(kind, now=None):
        raise DatabaseError("down")

    monkeypatch.setattr(alerts, "quiet", broken)

    server_errors(3)

    assert (alerts.ERROR_SPIKE, {"count": 3, "minutes": 5}) in Recorder.sent


def test_an_alert_cannot_break_the_transaction_it_was_sent_from(monkeypatch):
    from django.db import transaction

    from core.models import Owner

    real = Alert.objects.create

    def after_insert(**fields):
        real(**fields)
        raise DatabaseError("after the insert")

    monkeypatch.setattr(Alert.objects, "create", after_insert)
    with transaction.atomic():
        notify.send("vital_action_requested", kind="add_passkey")
        assert Owner.objects.count() == 1

    assert kinds() == []


def test_required_notices_still_need_a_notifier_outside_the_site(elevated, settings):
    settings.NOTIFIERS = ["core.notify.DatabaseNotifier"]

    with pytest.raises(notify.Undelivered):
        notify.send_required("vital_action_requested", kind="add_passkey")
    response = request_delete(elevated)

    assert response.status_code == 503
    assert PendingAction.objects.count() == 0
    assert kinds() == []


# The routes


def test_alerts_need_a_session(api, passkey):
    assert api.get("/alerts").status_code == 401
    assert (
        api.post(f"/alerts/{'0' * 8}-0000-4000-8000-{'0' * 12}/seen").status_code == 401
    )


def test_alerts_are_listed_newest_first_in_pages(signed_in):
    now = timezone.now()
    made = [
        Alert.objects.create(
            kind=alerts.ERROR_SPIKE,
            summary=f"{n}",
            created_at=now - timedelta(minutes=n),
        )
        for n in range(5)
    ]

    first = signed_in.get("/alerts", {"limit": "2"}).json()
    second = signed_in.get(
        "/alerts", {"limit": "2", "before": first["next_before"]}
    ).json()
    last = signed_in.get(
        "/alerts", {"limit": "2", "before": second["next_before"]}
    ).json()

    assert [a["summary"] for a in first["alerts"]] == ["0", "1"]
    assert [a["summary"] for a in second["alerts"]] == ["2", "3"]
    assert [a["summary"] for a in last["alerts"]] == ["4"]
    assert last["next_before"] is None
    assert first["unseen"] == 5
    assert set(first["alerts"][0]) == {"id", "at", "kind", "summary", "seen"}
    assert first["alerts"][0]["id"] == str(made[0].id)


def test_alerts_can_be_filtered_to_unseen_and_marked_seen(signed_in):
    old = Alert.objects.create(kind=alerts.ERROR_SPIKE, summary="old")
    new = Alert.objects.create(kind=alerts.PASSKEY_ADDED, summary="new")

    response = signed_in.post(f"/alerts/{old.id}/seen")
    again = signed_in.post(f"/alerts/{old.id}/seen")
    body = signed_in.get("/alerts", {"unseen": "1"}).json()

    assert response.status_code == again.status_code == 200
    assert response.json()["seen"] is True
    assert [a["id"] for a in body["alerts"]] == [str(new.id)]
    assert body["unseen"] == 1
    entries = AuditLog.objects.filter(event="alert_seen")
    assert entries.count() == 1
    assert entries.get().detail == {"id": str(old.id), "kind": alerts.ERROR_SPIKE}


def test_marking_an_unknown_alert_is_not_found(signed_in):
    response = signed_in.post("/alerts/00000000-0000-4000-8000-000000000000/seen")

    assert response.status_code == 404


@pytest.mark.parametrize(
    "params",
    [
        {"unseen": "0"},
        {"unseen": "yes"},
        {"limit": "0"},
        {"limit": "101"},
        {"limit": "x"},
        {"before": "not-an-id"},
        {"before": "00000000-0000-4000-8000-000000000000"},
        {"page": "2"},
    ],
)
def test_bad_alert_parameters_are_refused(signed_in, params):
    assert signed_in.get("/alerts", params).status_code == 400
