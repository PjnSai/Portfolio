"""The two CV switches, view and request: on by default, changed only by a
vital action (fresh passkey, 24-hour wait, notice and cancel)."""

import pytest

from core import cv
from core.models import AuditLog, PendingAction, SiteSettings
from tests.conftest import age_sessions, mature
from tests.notifiers import Recorder

pytestmark = pytest.mark.django_db

URL = "/cv/switches"


def request_change(api, payload):
    return api.post(
        "/vital-actions/request", {"kind": "cv_switches", "payload": payload}
    )


def reconfirm(api, passkey):
    age_sessions(minutes=6)
    assert api.elevate(passkey).status_code == 200


def test_both_are_on_before_any_settings_are_saved(signed_in):
    response = signed_in.get(URL)

    assert response.status_code == 200
    assert response.json() == {"view": True, "request": True, "pending": []}
    assert SiteSettings.objects.count() == 0
    assert cv.switches() == {"view": True, "request": True}


def test_reading_them_needs_a_session(api, passkey):
    assert api.get(URL).status_code == 401


def test_a_change_waits_24_hours_and_says_so(elevated):
    response = request_change(elevated, {"view": False, "request": True})

    assert response.status_code == 201
    assert response.json()["kind"] == "cv_switches"
    assert response.json()["target"] == {"view": False, "request": True}
    assert response.json()["state"] == "waiting"
    assert cv.switches() == {"view": True, "request": True}
    assert [event for event, _ in Recorder.sent] == ["vital_action_requested"]
    pending = elevated.get(URL).json()["pending"]
    assert [p["target"] for p in pending] == [{"view": False, "request": True}]


def test_a_change_needs_a_fresh_passkey(signed_in):
    response = request_change(signed_in, {"view": False, "request": False})

    assert response.status_code == 403
    assert PendingAction.objects.count() == 0


def test_a_change_runs_after_the_wait(elevated, passkey):
    action = request_change(elevated, {"view": False, "request": False}).json()
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    response = elevated.post(f"/vital-actions/{action['id']}/execute")

    assert response.status_code == 200
    assert cv.switches() == {"view": False, "request": False}
    assert elevated.get(URL).json() == {"view": False, "request": False, "pending": []}
    assert AuditLog.objects.get(event="cv_switches_changed").detail == {
        "view": False,
        "request": False,
    }


def test_a_change_cannot_run_early(elevated, passkey):
    action = request_change(elevated, {"view": False, "request": True}).json()
    mature(PendingAction.objects.get(), hours=23, minutes=59)
    reconfirm(elevated, passkey)

    response = elevated.post(f"/vital-actions/{action['id']}/execute")

    assert response.status_code == 409
    assert cv.switches() == {"view": True, "request": True}


def test_a_cancelled_change_never_runs(elevated, passkey):
    action = request_change(elevated, {"view": True, "request": False}).json()
    assert elevated.post(f"/vital-actions/{action['id']}/cancel").status_code == 200
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    assert elevated.post(f"/vital-actions/{action['id']}/execute").status_code == 409
    assert cv.switches() == {"view": True, "request": True}
    assert elevated.get(URL).json()["pending"] == []


def test_turning_them_back_on_is_also_a_vital_action(elevated, passkey):
    SiteSettings.objects.create(cv_view_enabled=False, cv_request_enabled=False)

    response = request_change(elevated, {"view": True, "request": True})

    assert response.status_code == 201
    assert cv.switches() == {"view": False, "request": False}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"view": False},
        {"request": False},
        {"view": "false", "request": True},
        {"view": 0, "request": True},
        {"view": None, "request": True},
        {"view": True, "request": True, "download": True},
        [True, True],
    ],
)
def test_the_payload_must_be_both_booleans_and_nothing_else(elevated, payload):
    response = request_change(elevated, payload)

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0
