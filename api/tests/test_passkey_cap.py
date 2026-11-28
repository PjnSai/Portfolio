import pytest

from core.models import AdminCredential, AuditLog, PendingAction
from tests.authenticator import SoftAuthenticator
from tests.conftest import mature
from tests.notifiers import Recorder
from tests.test_vital import reconfirm, request_revoke

pytestmark = pytest.mark.django_db

LIMIT = {"detail": "Not possible right now.", "code": "passkey_limit"}


def add_spares(count):
    """Stored passkeys beside the signed-in one."""
    return [
        AdminCredential.objects.create(
            credential_id=bytes([n + 1]) * 32, public_key=b"k", name=f"Spare {n}"
        )
        for n in range(count)
    ]


def ask_to_add(api, name="Another key"):
    return api.post(
        "/vital-actions/request",
        {"kind": "add_passkey", "payload": {"name": name}},
    )


def run_add(api, passkey, action_id):
    options = api.post(f"/vital-actions/{action_id}/passkey-options")
    if options.status_code != 200:
        return options
    return api.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options.json())},
    )


def test_the_cap_is_five_by_default(settings):
    assert settings.ADMIN_MAX_PASSKEYS == 5


def test_a_sixth_passkey_is_refused_before_anything_is_queued(elevated, passkey):
    add_spares(4)
    Recorder.sent.clear()

    response = ask_to_add(elevated)

    assert response.status_code == 409
    assert response.json() == LIMIT
    assert PendingAction.objects.count() == 0
    assert not any(event == "vital_action_requested" for event, _ in Recorder.sent)
    assert AuditLog.objects.filter(event="vital_action_refused").exists()


def test_a_fifth_passkey_may_still_be_requested(elevated, passkey):
    add_spares(3)

    assert ask_to_add(elevated).status_code == 201


def test_the_cap_follows_the_setting(elevated, passkey, settings):
    settings.ADMIN_MAX_PASSKEYS = 2
    add_spares(1)

    assert ask_to_add(elevated).status_code == 409


def test_revoking_one_frees_a_slot(elevated, passkey):
    spares = add_spares(4)
    assert ask_to_add(elevated).status_code == 409

    action_id = request_revoke(elevated, spares[0]).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    assert elevated.post(f"/vital-actions/{action_id}/execute").status_code == 200

    response = ask_to_add(elevated)
    assert response.status_code == 201
    mature(PendingAction.objects.get(id=response.json()["id"]), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    assert run_add(elevated, passkey, response.json()["id"]).status_code == 200
    assert AdminCredential.objects.count() == 5


def test_the_cap_is_checked_again_when_the_action_runs(elevated, passkey):
    add_spares(3)
    action_id = ask_to_add(elevated).json()["id"]
    # Filled up while the request waited (another add ran first).
    AdminCredential.objects.create(
        credential_id=b"z" * 32, public_key=b"k", name="Late"
    )
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)

    options = elevated.post(f"/vital-actions/{action_id}/passkey-options")
    assert options.status_code == 409
    assert options.json() == LIMIT


def test_the_cap_is_checked_inside_the_run_itself(elevated, passkey):
    add_spares(3)
    action_id = ask_to_add(elevated).json()["id"]
    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    options = elevated.post(f"/vital-actions/{action_id}/passkey-options")
    assert options.status_code == 200
    AdminCredential.objects.create(
        credential_id=b"z" * 32, public_key=b"k", name="Late"
    )

    response = elevated.post(
        f"/vital-actions/{action_id}/execute",
        {"credential": SoftAuthenticator().create(options.json())},
    )

    assert response.status_code == 409
    assert response.json() == LIMIT
    assert AdminCredential.objects.count() == 5
    assert PendingAction.objects.get().status == "pending"
