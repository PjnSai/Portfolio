from datetime import timedelta

import pytest
from django.utils import timezone

from core.models import (
    AdminCredential,
    AuditLog,
    Message,
    PendingAction,
    Project,
    ProjectField,
)
from tests.authenticator import SoftAuthenticator
from tests.conftest import ADMIN, age_sessions, mature
from tests.notifiers import Recorder

pytestmark = pytest.mark.django_db


@pytest.fixture
def project():
    project = Project.objects.create(slug="demo", title="Demo")
    ProjectField.objects.create(project=project, label="Role", value="Author")
    return project


def request_delete(api, project):
    return api.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "project", "id": str(project.id)},
        },
    )


def reconfirm(api, passkey):
    """Passkey confirmation only lasts minutes, so it is repeated after the wait."""
    age_sessions(minutes=6)
    assert api.elevate(passkey).status_code == 200


def test_request_starts_a_24_hour_wait_and_does_nothing_yet(elevated, project):
    response = request_delete(elevated, project)

    assert response.status_code == 201
    body = response.json()
    action = PendingAction.objects.get()
    assert body["id"] == str(action.id)
    assert body["state"] == "waiting"
    assert action.execute_after - action.requested_at == timedelta(hours=24)
    assert Project.objects.filter(id=project.id).exists()


def test_request_sends_a_notice_with_a_cancel_link(elevated, project):
    body = request_delete(elevated, project).json()

    assert body["cancel_path"] == f"{ADMIN}/vital-actions/{body['id']}/cancel"
    event, context = Recorder.sent[-1]
    assert event == "vital_action_requested"
    assert context["cancel_path"] == body["cancel_path"]
    assert context["kind"] == "permanent_delete"
    assert AuditLog.objects.filter(event="vital_action_requested").exists()


def test_request_fails_closed_when_the_notice_cannot_be_sent(
    elevated, project, settings
):
    settings.NOTIFIERS = ["tests.notifiers.Broken"]

    response = request_delete(elevated, project)

    assert response.status_code == 503
    assert PendingAction.objects.count() == 0


def test_pending_actions_are_listed_for_the_banner_and_page(elevated, project):
    request_delete(elevated, project)

    listed = elevated.get("/vital-actions").json()["actions"]

    assert len(listed) == 1
    assert listed[0]["kind"] == "permanent_delete"
    assert listed[0]["state"] == "waiting"
    assert listed[0]["execute_after"]
    assert listed[0]["cancel_path"].endswith("/cancel")
    assert elevated.get("/session").json()["pending_actions"] == 1


def test_cannot_run_before_the_wait_is_over(elevated, project):
    action_id = request_delete(elevated, project).json()["id"]

    response = elevated.post(f"/vital-actions/{action_id}/execute")

    assert response.status_code == 409
    assert Project.objects.filter(id=project.id).exists()


def test_cannot_run_a_minute_early(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), hours=23, minutes=59)
    reconfirm(elevated, passkey)

    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 409


def test_stolen_session_cannot_run_a_matured_action(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    age_sessions(minutes=6)

    response = elevated.post(f"/vital-actions/{action_id}/execute")

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert Project.objects.filter(id=project.id).exists()


def test_permanent_delete_removes_the_row_and_its_children(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    response = elevated.post(f"/vital-actions/{action_id}/execute")

    assert response.status_code == 200
    assert response.json()["state"] == "done"
    assert not Project.objects.filter(id=project.id).exists()
    assert ProjectField.objects.count() == 0
    assert AuditLog.objects.filter(event="vital_action_executed").exists()
    assert elevated.get("/vital-actions").json()["actions"] == []


def test_action_runs_once(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 200

    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 409


def test_cancel_needs_only_a_session_and_stops_the_action(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    age_sessions(minutes=6)

    response = elevated.post(f"/vital-actions/{action_id}/cancel")

    assert response.status_code == 200
    assert response.json()["state"] == "cancelled"
    assert AuditLog.objects.filter(event="vital_action_cancelled").exists()
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    assert elevated.elevate(passkey).status_code == 200
    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 409
    assert Project.objects.filter(id=project.id).exists()


def test_action_left_too_long_expires(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), days=9)
    reconfirm(elevated, passkey)

    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 409
    assert Project.objects.filter(id=project.id).exists()


def test_messages_can_be_permanently_deleted(elevated, passkey):
    message = Message.objects.create(name="A", email="a@example.com", body="Hi")
    action_id = elevated.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "message", "id": str(message.id)},
        },
    ).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 200
    assert Message.objects.count() == 0


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"kind": "wipe_everything", "payload": {}},
        {"kind": "permanent_delete", "payload": {}},
        {"kind": "permanent_delete", "payload": {"entity": "audit_log", "id": "x"}},
        {
            "kind": "permanent_delete",
            "payload": {
                "entity": "audit_log",
                "id": "00000000-0000-4000-8000-000000000000",
            },
        },
        {
            "kind": "permanent_delete",
            "payload": {
                "entity": "session",
                "id": "00000000-0000-4000-8000-000000000000",
            },
        },
        {
            "kind": "permanent_delete",
            "payload": {
                "entity": "project",
                "id": "00000000-0000-4000-8000-000000000000",
            },
        },
        {"kind": "add_passkey", "payload": {}},
        {"kind": "add_passkey", "payload": {"name": ""}},
    ],
)
def test_invalid_requests_are_refused(elevated, body):
    response = elevated.post("/vital-actions/request", body)

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0


def request_passkey(api):
    return api.post(
        "/vital-actions/request",
        {"kind": "add_passkey", "payload": {"name": "Second key"}},
    ).json()["id"]


def test_adding_a_passkey_waits_24_hours(elevated, passkey):
    action_id = request_passkey(elevated)

    response = elevated.post(f"/vital-actions/{action_id}/passkey-options")

    assert response.status_code == 409
    assert AdminCredential.objects.count() == 1


def test_adding_a_passkey_after_the_wait(elevated, new_api, passkey):
    action_id = request_passkey(elevated)
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    second = SoftAuthenticator()

    options = elevated.post(f"/vital-actions/{action_id}/passkey-options")
    assert options.status_code == 200
    assert options.json()["authenticatorSelection"]["userVerification"] == "required"
    assert len(options.json()["excludeCredentials"]) == 1
    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": second.create(options.json())},
    )

    assert response.status_code == 200
    assert AdminCredential.objects.count() == 2
    assert AdminCredential.objects.filter(name="Second key").exists()
    assert AuditLog.objects.filter(event="passkey_added").exists()
    assert ("passkey_added", {"name": "Second key"}) in Recorder.sent
    assert new_api().login(second).status_code == 200


def test_bad_registration_leaves_the_action_ready(elevated, passkey):
    action_id = request_passkey(elevated)
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options").json()

    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options, origin="https://evil.test")},
    )

    assert response.status_code == 400
    assert AdminCredential.objects.count() == 1
    assert PendingAction.objects.get().status == "pending"


def test_passkey_options_are_only_for_passkey_actions(elevated, passkey, project):
    action_id = request_delete(elevated, project).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    response = elevated.post(f"/vital-actions/{action_id}/passkey-options")

    assert response.status_code == 409


def test_unknown_action_is_not_found(elevated):
    missing = "00000000-0000-4000-8000-000000000000"

    assert elevated.post(f"/vital-actions/{missing}/execute").status_code == 404
    assert elevated.post(f"/vital-actions/{missing}/cancel").status_code == 404


def test_delay_cannot_be_shortened_by_the_client(elevated, project):
    response = elevated.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "project", "id": str(project.id)},
            "execute_after": timezone.now().isoformat(),
            "delay": 0,
        },
    )

    assert response.status_code == 201
    action = PendingAction.objects.get()
    assert action.execute_after - action.requested_at == timedelta(hours=24)
    assert "execute_after" not in action.payload


def request_revoke(api, credential):
    return api.post(
        "/vital-actions/request",
        {"kind": "revoke_passkey", "payload": {"id": str(credential.id)}},
    )


def test_revoking_a_passkey_waits_24_hours(elevated, passkey):
    credential = AdminCredential.objects.get()
    action_id = request_revoke(elevated, credential).json()["id"]

    response = elevated.post(f"/vital-actions/{action_id}/execute")

    assert response.status_code == 409
    assert AdminCredential.objects.count() == 1


def test_revoking_a_passkey_after_the_wait(elevated, new_api, passkey):
    spare = AdminCredential.objects.create(
        credential_id=b"s" * 32, public_key=b"k", name="Spare"
    )
    action_id = request_revoke(elevated, spare).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    response = elevated.post(f"/vital-actions/{action_id}/execute")

    assert response.status_code == 200
    assert not AdminCredential.objects.filter(id=spare.id).exists()
    assert AuditLog.objects.filter(event="passkey_revoked").exists()
    assert ("passkey_revoked", {"name": "Spare"}) in Recorder.sent
    assert new_api().login(passkey).status_code == 200


@pytest.mark.parametrize(
    "payload",
    [{}, {"id": "not-a-uuid"}, {"id": "00000000-0000-4000-8000-000000000000"}],
)
def test_revoking_an_unknown_passkey_is_refused(elevated, payload):
    response = elevated.post(
        "/vital-actions/request", {"kind": "revoke_passkey", "payload": payload}
    )

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0


def test_passkeys_are_listed_without_key_material(signed_in, passkey):
    body = signed_in.get("/passkeys").json()

    credential = AdminCredential.objects.get()
    assert body == {
        "passkeys": [
            {
                "id": str(credential.id),
                "name": "Test key",
                "created_at": credential.created_at.isoformat(),
                "last_used_at": credential.last_used_at.isoformat(),
            }
        ]
    }
