"""The Resend email notifier. Every test uses a fake transport: nothing here
reaches the network."""

import json
import logging
import secrets
from email.message import Message
from urllib.error import HTTPError, URLError

import pytest

from core import notify
from core.models import AdminCredential, AuditLog, PendingAction
from tests.authenticator import SoftAuthenticator
from tests.conftest import mature, new_message

pytestmark = pytest.mark.django_db

KEY = "re_test_" + "k" * 24
SENDER = "notices@mail.portfolio.test"
OWNER = "owner-inbox@portfolio.test"
EMAIL_ONLY = ["core.notify.DatabaseNotifier", "core.notify.ResendNotifier"]


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Transport:
    """Stands in for urlopen: keeps each request and answers as told."""

    def __init__(self, answer=None):
        self.answer = answer or FakeResponse()
        self.sent = []

    def __call__(self, request, timeout):
        self.sent.append((request, timeout))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    def body(self, index=-1):
        return json.loads(self.sent[index][0].data)


def http_error(code):
    return HTTPError(notify.EMAIL_URL, code, "refused", Message(), None)


@pytest.fixture
def configured(settings):
    settings.RESEND_API_KEY = KEY
    settings.NOTICE_EMAIL_FROM = SENDER
    settings.NOTICE_EMAIL_TO = OWNER
    settings.NOTIFIERS = EMAIL_ONLY
    return settings


@pytest.fixture
def transport(monkeypatch):
    fake = Transport()
    monkeypatch.setattr(notify, "urlopen", fake)
    return fake


def delete_body():
    message = new_message()
    return {
        "kind": "permanent_delete",
        "payload": {"entity": "message", "id": str(message.id)},
    }


def test_a_notice_is_posted_to_resend_with_the_key(configured, transport):
    notify.send_required("vital_action_requested", kind="add_passkey")

    request, timeout = transport.sent[0]
    assert request.full_url == "https://api.resend.com/emails"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == f"Bearer {KEY}"
    assert request.get_header("Content-type") == "application/json"
    assert timeout == 5
    body = transport.body()
    assert set(body) == {"from", "to", "subject", "text"}
    assert body["from"] == SENDER
    assert body["to"] == [OWNER]
    assert body["subject"] == "Portfolio: Vital action requested"
    assert "add a passkey" in body["text"]
    assert "UTC" in body["text"]


def test_the_email_is_plain_text_without_links(configured, transport):
    notify.send_required(
        "vital_action_requested",
        id="00000000-0000-4000-8000-000000000000",
        kind="permanent_delete",
        execute_after="2026-11-28T10:00:00+00:00",
        cancel_path="/admin/vital-actions/00000000/cancel",
    )

    body = transport.body()
    assert "html" not in body
    assert "://" not in body["text"]
    assert "/cancel" not in body["text"]
    assert "00000000" not in body["text"]


def test_the_notifier_is_not_in_band_and_not_a_default():
    from config import settings as defaults

    assert not getattr(notify.ResendNotifier(), "in_band", False)
    assert "core.notify.ResendNotifier" not in defaults.NOTIFIERS


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError("timed out"),
        URLError(ConnectionRefusedError("refused")),
        ConnectionResetError("reset"),
        http_error(400),
        http_error(401),
        http_error(422),
        http_error(500),
        http_error(503),
    ],
)
def test_a_failed_send_raises_and_a_required_notice_is_undelivered(
    configured, monkeypatch, error
):
    monkeypatch.setattr(notify, "urlopen", Transport(error))

    with pytest.raises(notify.EmailFailed):
        notify.ResendNotifier().send("vital_action_requested", {"kind": "x"})
    with pytest.raises(notify.Undelivered):
        notify.send_required("vital_action_requested", kind="add_passkey")


@pytest.mark.parametrize("status", [199, 302, 400, 500])
def test_an_answer_outside_2xx_raises(configured, monkeypatch, status):
    monkeypatch.setattr(notify, "urlopen", Transport(FakeResponse(status)))

    with pytest.raises(notify.Undelivered):
        notify.send_required("passkey_revoked", name="Spare")


def test_redirects_are_not_followed():
    assert notify._NoRedirect().redirect_request() is None


@pytest.mark.parametrize(
    "missing", ["RESEND_API_KEY", "NOTICE_EMAIL_FROM", "NOTICE_EMAIL_TO"]
)
def test_a_missing_setting_fails_closed(configured, transport, missing):
    setattr(configured, missing, "")

    with pytest.raises(notify.Undelivered):
        notify.send_required("vital_action_requested", kind="add_passkey")
    assert transport.sent == []


def test_errors_never_log_the_key_or_headers(configured, monkeypatch, caplog):
    monkeypatch.setattr(notify, "urlopen", Transport(http_error(401)))

    with caplog.at_level(logging.DEBUG):
        notify.send_if_possible("error_spike", count=20, minutes=5)
        with pytest.raises(notify.Undelivered):
            notify.send_required("vital_action_requested", kind="add_passkey")

    assert caplog.records
    assert KEY not in caplog.text
    assert "Bearer" not in caplog.text
    assert "Authorization" not in caplog.text
    assert OWNER not in caplog.text
    assert "HTTPError" in caplog.text


def test_unknown_events_are_not_emailed(configured, transport):
    notify.send("not_an_event", count=3)

    assert transport.sent == []


SMUGGLED = {
    "email": "visitor@example.org",
    "message": "Hello, please call me on the number below about the role",
    "session": secrets.token_urlsafe(32),
    "secret": "re_" + secrets.token_urlsafe(24),
}
WHITELISTED = ("name", "kind", "via", "scope", "count", "minutes", "passkeys")


@pytest.mark.parametrize("event", sorted(notify.EMAIL_TEXT))
@pytest.mark.parametrize("value", sorted(SMUGGLED.values()))
def test_nothing_personal_or_secret_reaches_the_request(
    configured, transport, event, value
):
    context = {f"extra_{label}": v for label, v in SMUGGLED.items()}
    context.update({field: value for field in WHITELISTED})
    context.update(SMUGGLED)

    notify.ResendNotifier().send(event, context)

    request, _ = transport.sent[0]
    body = transport.body()
    for smuggled in SMUGGLED.values():
        assert smuggled not in request.data.decode()
        assert smuggled not in json.dumps(request.headers)
    assert "@" not in body["subject"] + body["text"]


def test_a_passkey_name_is_included(configured, transport):
    notify.send_required("passkey_added", name="Phone (spare)")

    assert '"Phone (spare)"' in transport.body()["text"]


# Vital actions with the email notifier failing


def test_vital_action_is_refused_when_the_email_fails(
    elevated, configured, monkeypatch
):
    monkeypatch.setattr(notify, "urlopen", Transport(http_error(500)))

    response = elevated.post("/vital-actions/request", delete_body())

    assert response.status_code == 503
    assert PendingAction.objects.count() == 0
    assert not AuditLog.objects.filter(event="vital_action_requested").exists()


def test_vital_action_is_refused_when_resend_times_out(
    elevated, configured, monkeypatch
):
    monkeypatch.setattr(notify, "urlopen", Transport(TimeoutError("timed out")))

    response = elevated.post("/vital-actions/request", delete_body())

    assert response.status_code == 503
    assert PendingAction.objects.count() == 0


def test_vital_action_goes_ahead_when_the_email_is_sent(
    elevated, configured, transport
):
    response = elevated.post("/vital-actions/request", delete_body())

    assert response.status_code == 201
    assert PendingAction.objects.count() == 1
    assert transport.body()["subject"] == "Portfolio: Vital action requested"


def test_new_passkey_is_undone_when_the_email_fails(
    elevated, passkey, configured, monkeypatch
):
    configured.NOTIFIERS = ["tests.notifiers.Recorder"]
    action_id = elevated.post(
        "/vital-actions/request",
        {"kind": "add_passkey", "payload": {"name": "Second key"}},
    ).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options").json()
    configured.NOTIFIERS = EMAIL_ONLY
    monkeypatch.setattr(notify, "urlopen", Transport(ConnectionResetError("reset")))

    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options)},
    )

    assert response.status_code == 503
    assert AdminCredential.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"
    assert not AuditLog.objects.filter(event="vital_action_executed").exists()
