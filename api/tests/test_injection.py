import re
from pathlib import Path

import pytest

from core import audit
from core.models import AdminCredential, AuditLog, PendingAction, Session

pytestmark = pytest.mark.django_db

PAYLOADS = [
    "' OR '1'='1",
    "' OR 1=1--",
    "'; DROP TABLE audit_log;--",
    "1; DELETE FROM sessions WHERE 1=1;--",
    "' UNION SELECT token_hash, null FROM sessions--",
    "admin'/*",
    "\\'; SELECT pg_sleep(5);--",
    "%27%20OR%201=1",
    "login' AND (SELECT COUNT(*) FROM admin_credentials) > 0 AND 'a'='a",
    "\x00",
]


@pytest.fixture
def seeded(signed_in):
    audit.record("publish", marker="kept")
    return signed_in


def assert_database_intact(sessions=1):
    assert AuditLog.objects.filter(event="publish").count() == 1
    assert Session.objects.filter(revoked_at=None).count() == sessions
    assert AdminCredential.objects.count() == 1
    assert audit.verify_chain().ok is True


@pytest.mark.parametrize("payload", PAYLOADS)
def test_audit_filter_treats_payload_as_plain_text(seeded, payload):
    response = seeded.get("/audit", {"event": payload})

    assert response.status_code in (200, 400)
    if response.status_code == 200:
        assert response.json()["entries"] == []
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("name", ["before", "limit"])
def test_audit_paging_rejects_payloads(seeded, payload, name):
    response = seeded.get("/audit", {name: payload})

    assert response.status_code == 400
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS[:-1])
def test_session_cookie_payload_is_just_a_wrong_session(seeded, payload):
    seeded.set_cookie(payload)

    assert seeded.get("/session").status_code == 401
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS)
def test_csrf_header_payload_is_refused(seeded, payload):
    response = seeded.post("/logout", headers={"X-CSRF-Token": payload})

    assert response.status_code in (400, 403)
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS)
def test_vital_action_payloads_are_validated(seeded, passkey, payload):
    seeded.elevate(passkey)
    bodies = [
        {"kind": payload, "payload": {}},
        {"kind": "permanent_delete", "payload": {"entity": payload, "id": payload}},
        {"kind": "permanent_delete", "payload": {"entity": "project", "id": payload}},
    ]

    for body in bodies:
        assert seeded.post("/vital-actions/request", body).status_code == 400
    assert PendingAction.objects.count() == 0
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS)
def test_action_id_in_the_path_must_be_a_uuid(seeded, payload):
    response = seeded.post(f"/vital-actions/{payload}/cancel")

    assert response.status_code in (400, 404)
    assert_database_intact()


@pytest.mark.parametrize("payload", PAYLOADS)
def test_sign_in_payloads_fail_like_any_other_sign_in(seeded, new_api, payload):
    credential = {
        "id": payload,
        "rawId": payload,
        "type": "public-key",
        "response": {
            "clientDataJSON": payload,
            "authenticatorData": payload,
            "signature": payload,
        },
    }

    response = new_api().post("/login/verify", {"credential": credential})

    assert response.status_code in (400, 401)
    assert_database_intact()


def test_stored_text_is_never_interpreted_as_sql(seeded):
    for payload in PAYLOADS[:-1]:
        audit.record("settings_change", note=payload)

    listed = seeded.get("/audit", {"event": "settings_change"}).json()["entries"]

    assert len(listed) == len(PAYLOADS) - 1
    assert_database_intact()


def test_application_code_has_no_hand_written_sql():
    source = Path(__file__).resolve().parent.parent
    pattern = re.compile(r"\.(raw|extra|cursor)\(|RawSQL|\.execute\(")
    offenders = [
        f"{path.name}:{number}"
        for folder in ("core", "config")
        for path in (source / folder).rglob("*.py")
        if "migrations" not in path.parts
        for number, line in enumerate(path.read_text().splitlines(), 1)
        if pattern.search(line)
    ]

    assert offenders == []
