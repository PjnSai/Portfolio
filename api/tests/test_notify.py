import logging

import pytest

from core import notify
from core.models import AdminCredential, AuditLog, Message, PendingAction
from tests.authenticator import SoftAuthenticator
from tests.conftest import mature
from tests.notifiers import Recorder

pytestmark = pytest.mark.django_db

DELETE = {"kind": "permanent_delete"}
ADD = {"kind": "add_passkey", "payload": {"name": "Second key"}}


def delete_body():
    message = Message.objects.create(name="A", email="a@example.com", body="Hi")
    return DELETE | {"payload": {"entity": "message", "id": str(message.id)}}


def test_notifiers_are_chosen_in_settings(settings):
    settings.NOTIFIERS = ["tests.notifiers.Recorder", "core.notify.LogNotifier"]

    notify.send("lockout", scope="login")

    assert Recorder.sent == [("lockout", {"scope": "login"})]


def test_required_notice_fails_without_a_notifier(settings):
    settings.NOTIFIERS = []

    notify.send("lockout", scope="login")
    with pytest.raises(notify.Undelivered):
        notify.send_required("vital_action_requested", kind="add_passkey")


def test_required_notice_fails_when_any_notifier_fails(settings):
    settings.NOTIFIERS = ["tests.notifiers.Recorder", "tests.notifiers.Broken"]

    with pytest.raises(notify.Undelivered):
        notify.send_required("vital_action_requested", kind="add_passkey")


def test_log_notifier_writes_the_notice_to_the_log(settings, caplog):
    settings.NOTIFIERS = ["core.notify.LogNotifier"]

    with caplog.at_level(logging.WARNING, logger="core.notify"):
        notify.send_required("vital_action_requested", kind="add_passkey")

    assert "vital_action_requested" in caplog.text
    assert "add_passkey" in caplog.text


def test_vital_action_is_refused_when_no_notifier_is_configured(elevated, settings):
    settings.NOTIFIERS = []

    response = elevated.post("/vital-actions/request", delete_body())

    assert response.status_code == 503
    assert response.json() == {"detail": "Service unavailable."}
    assert PendingAction.objects.count() == 0
    assert not AuditLog.objects.filter(event="vital_action_requested").exists()
    assert AuditLog.objects.filter(event="vital_action_refused").exists()


def test_notice_holds_no_secrets(elevated):
    elevated.post("/vital-actions/request", delete_body())

    text = str(Recorder.sent)
    assert elevated.cookie not in text
    assert elevated.csrf not in text
    assert "127.0.0.1" not in text


def test_new_passkey_is_undone_when_the_owner_cannot_be_told(
    elevated, passkey, settings
):
    action_id = elevated.post("/vital-actions/request", ADD).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options").json()
    settings.NOTIFIERS = ["tests.notifiers.Broken"]

    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options)},
    )

    assert response.status_code == 503
    assert AdminCredential.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"
    assert not AuditLog.objects.filter(event="vital_action_executed").exists()
