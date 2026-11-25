"""The owner's inbox API under /api/v1/admin/messages."""

import json
from datetime import timedelta

import pytest
from django.utils import timezone

from core import admin_urls, audit
from core.authz import Level
from core.models import AuditLog, ContactMessage, ContactNote, PendingAction
from tests.conftest import PLACEHOLDER_ID, Api, age_sessions, mature

pytestmark = pytest.mark.django_db

PERSON = "Rosalind Quillfeather"
MAIL = "rosalind.quillfeather@inbox-example.org"
WORDS = "a long confidential paragraph about marmalade"


def make(status="new", **fields):
    values = {
        "name": PERSON,
        "email": MAIL,
        "body": f"Hello, {WORDS}.",
        "status": status,
        "created_at": timezone.now(),
        "ip_hash": "f" * 64,
    }
    values.update(fields)
    days = 30 if status == "spam" else 365
    values.setdefault("expires_at", values["created_at"] + timedelta(days=days))
    return ContactMessage.objects.create(**values)


def make_many(count, status="new"):
    start = timezone.now() - timedelta(days=1)
    return [
        make(status, created_at=start + timedelta(seconds=n), body=f"Message {n}.")
        for n in range(count)
    ]


def events():
    """The inbox's own audit events (signing in writes one too)."""
    names = AuditLog.objects.order_by("seq").values_list("event", flat=True)
    return [name for name in names if name.startswith("message_")]


def last_audit():
    return AuditLog.objects.order_by("-seq").first()


# Permissions


def routes(message_id=PLACEHOLDER_ID):
    base = f"/messages/{message_id}"
    return [
        ("GET", "/messages"),
        ("GET", base),
        ("POST", f"{base}/status"),
        ("POST", f"{base}/notes"),
        ("POST", f"{base}/responded"),
        ("POST", f"{base}/keep"),
        ("POST", f"{base}/not-spam"),
        ("GET", "/retention"),
        ("PATCH", "/retention"),
    ]


MATRIX = [pytest.param(m, p, id=f"{m} {p}") for m, p in routes()]


def test_every_inbox_route_needs_a_signed_in_owner():
    found = {}
    for pattern in admin_urls.urlpatterns:
        text = str(pattern.pattern)
        if text.startswith(("messages", "retention")):
            found[text] = pattern.callback.admin_level
    # Blocking a sender needs a confirmed passkey (tests/test_blocklist.py).
    assert found.pop("messages/<uuid:message_id>/block") is Level.ELEVATED
    assert len(found) == 8
    assert set(found.values()) == {Level.SESSION}


@pytest.mark.parametrize("method,path", MATRIX)
def test_anonymous_callers_are_refused(signed_in, method, path):
    make()

    response = signed_in.request(
        method, path, headers={"Cf-Access-Jwt-Assertion": None}
    )

    assert response.status_code == 403
    assert "Rosalind" not in response.content.decode()


@pytest.mark.parametrize("method,path", MATRIX)
def test_someone_else_with_a_valid_access_token_is_refused(
    new_api, access, method, path
):
    make()
    stranger = Api(access(email="stranger@portfolio.test"))

    response = stranger.request(method, path)

    assert response.status_code == 403


@pytest.mark.parametrize("method,path", MATRIX)
def test_access_without_a_passkey_session_is_refused(api, passkey, method, path):
    make()

    response = api.request(method, path)

    assert response.status_code == 401
    assert response.json() == {"detail": "Not signed in."}


@pytest.mark.parametrize("method,path", MATRIX)
def test_an_expired_session_is_refused(signed_in, method, path):
    make()
    age_sessions(hours=9)

    assert signed_in.request(method, path).status_code == 401


@pytest.mark.parametrize("method,path", MATRIX)
def test_a_made_up_session_is_refused(signed_in, method, path):
    make()
    signed_in.set_cookie("not-a-real-session-token")

    assert signed_in.request(method, path).status_code == 401


def test_refusals_change_nothing(api, passkey):
    message = make()
    before = ContactMessage.objects.values().get()
    count = AuditLog.objects.count()

    for method, path in routes(message.id):
        api.request(method, path)

    assert ContactMessage.objects.values().get() == before
    assert AuditLog.objects.count() == count
    assert not ContactNote.objects.exists()


@pytest.mark.parametrize(
    "method,path",
    [pytest.param(m, p, id=f"{m} {p}") for m, p in routes() if m == "POST"],
)
def test_changes_need_the_csrf_token(signed_in, method, path):
    message = make()
    path = path.replace(PLACEHOLDER_ID, str(message.id))

    response = signed_in.post(path, headers={"X-CSRF-Token": None})

    assert response.status_code == 403
    assert ContactMessage.objects.get().status == "new"


def test_a_signed_in_owner_gets_through(signed_in):
    message = make()

    assert signed_in.get("/messages").status_code == 200
    assert signed_in.get(f"/messages/{message.id}").status_code == 200


# The list


def test_an_empty_inbox(signed_in):
    body = signed_in.get("/messages").json()

    assert body == {
        "results": [],
        "page": 1,
        "pages": 1,
        "count": 0,
        "counts": {"new": 0, "read": 0, "replied": 0, "archived": 0, "spam": 0},
    }


def test_the_list_shows_what_the_owner_needs_and_no_more(signed_in):
    message = make(kept=True)

    (row,) = signed_in.get("/messages").json()["results"]

    assert set(row) == {
        "id",
        "name",
        "email",
        "status",
        "reason",
        "spam_score",
        "created_at",
        "kept",
        "contact_id",
        "snippet",
    }
    assert row["id"] == str(message.id)
    assert row["name"] == PERSON
    assert row["email"] == MAIL
    assert row["kept"] is True
    assert row["snippet"].startswith("Hello, a long confidential")


def test_the_snippet_is_one_short_line(signed_in):
    make(body="Line one.\n\nLine two.\n" + "x" * 500)

    (row,) = signed_in.get("/messages").json()["results"]

    assert "\n" not in row["snippet"]
    assert len(row["snippet"]) <= 140


def test_the_stored_address_hash_is_never_sent(signed_in):
    message = make()

    listing = signed_in.get("/messages").content.decode()
    detail = signed_in.get(f"/messages/{message.id}").content.decode()

    assert "ip_hash" not in listing + detail
    assert "f" * 64 not in listing + detail


def test_the_list_is_newest_first(signed_in):
    old, middle, new = make_many(3)

    ids = [r["id"] for r in signed_in.get("/messages").json()["results"]]

    assert ids == [str(new.id), str(middle.id), str(old.id)]


def test_quarantined_messages_are_not_in_the_main_inbox(signed_in):
    make("new")
    make("spam")

    body = signed_in.get("/messages").json()

    assert [r["status"] for r in body["results"]] == ["new"]
    assert body["count"] == 1


@pytest.mark.parametrize("status", ["new", "read", "replied", "archived", "spam"])
def test_filtering_by_status(signed_in, status):
    for each in ("new", "read", "replied", "archived", "spam"):
        make(each)

    body = signed_in.get("/messages", {"status": status}).json()

    assert [r["status"] for r in body["results"]] == [status]
    assert body["count"] == 1


def test_all_shows_every_status_including_spam(signed_in):
    for each in ("new", "read", "replied", "archived", "spam"):
        make(each)

    body = signed_in.get("/messages", {"status": "all"}).json()

    assert body["count"] == 5


def test_the_tab_counts(signed_in):
    for each, how_many in (("new", 3), ("read", 2), ("spam", 4)):
        make_many(how_many, each)

    body = signed_in.get("/messages", {"status": "read"}).json()

    assert body["counts"] == {
        "new": 3,
        "read": 2,
        "replied": 0,
        "archived": 0,
        "spam": 4,
    }


@pytest.mark.parametrize("status", ["trashed", "NEW", "", "new,read", "x" * 100])
def test_an_unknown_status_is_refused(signed_in, status):
    assert signed_in.get("/messages", {"status": status}).status_code == 400


def test_a_repeated_or_unknown_query_parameter_is_refused(signed_in):
    assert signed_in.get("/messages?status=new&status=read").status_code == 400
    assert signed_in.get("/messages", {"sort": "name"}).status_code == 400
    assert signed_in.get("/messages?page=1&page=2").status_code == 400


def pages(signed_in, **params):
    return signed_in.get("/messages", params).json()


def test_twenty_five_to_a_page(signed_in):
    make_many(26)

    first = pages(signed_in)
    second = pages(signed_in, page=2)

    assert (len(first["results"]), first["pages"], first["count"]) == (25, 2, 26)
    assert (len(second["results"]), second["page"]) == (1, 2)
    ids = [r["id"] for r in first["results"] + second["results"]]
    assert len(set(ids)) == 26


@pytest.mark.parametrize(
    "count,expected_pages", [(0, 1), (1, 1), (25, 1), (26, 2), (50, 2), (51, 3)]
)
def test_page_counts_at_the_edges(signed_in, count, expected_pages):
    make_many(count)

    assert pages(signed_in)["pages"] == expected_pages


def test_a_page_past_the_end_is_empty_not_an_error(signed_in):
    make_many(3)

    body = pages(signed_in, page=9)

    assert body["results"] == []
    assert body["pages"] == 1


@pytest.mark.parametrize("page", ["0", "-1", "abc", "1.5", "", "9999999999", " 1"])
def test_a_bad_page_number_is_refused(signed_in, page):
    assert signed_in.get("/messages", {"page": page}).status_code == 400


def test_pages_follow_the_status_filter(signed_in):
    make_many(30, "spam")
    make_many(3, "new")

    spam = pages(signed_in, status="spam", page=2)
    inbox = pages(signed_in)

    assert (len(spam["results"]), spam["pages"]) == (5, 2)
    assert (len(inbox["results"]), inbox["pages"]) == (3, 1)


def test_listing_writes_no_audit_entry(signed_in):
    make()
    before = AuditLog.objects.count()

    signed_in.get("/messages")

    assert AuditLog.objects.count() == before


# One message


def test_the_first_view_marks_it_read(signed_in):
    message = make()

    body = signed_in.get(f"/messages/{message.id}").json()

    message.refresh_from_db()
    assert message.status == "read"
    assert message.read_at is not None
    assert body["status"] == "read"
    assert body["name"] == PERSON
    assert body["email"] == MAIL
    assert body["body"] == f"Hello, {WORDS}."
    assert body["notes"] == []
    assert set(body) == {
        "id",
        "name",
        "email",
        "body",
        "reason",
        "spam_score",
        "status",
        "created_at",
        "read_at",
        "kept",
        "contact_id",
        "expires_at",
        "notes",
    }
    entry = last_audit()
    assert (entry.event, entry.detail) == ("message_read", {"id": str(message.id)})


def test_a_second_view_changes_nothing(signed_in):
    message = make()
    signed_in.get(f"/messages/{message.id}")
    message.refresh_from_db()
    first_read, count = message.read_at, AuditLog.objects.count()

    signed_in.get(f"/messages/{message.id}")

    message.refresh_from_db()
    assert message.read_at == first_read
    assert AuditLog.objects.count() == count


def test_opening_a_quarantined_message_does_not_change_it(signed_in):
    message = make("spam")

    body = signed_in.get(f"/messages/{message.id}").json()

    message.refresh_from_db()
    assert (message.status, message.read_at) == ("spam", None)
    assert body["status"] == "spam"
    assert events() == []


def test_opening_a_message_in_another_state_keeps_its_state(signed_in):
    message = make("replied")

    signed_in.get(f"/messages/{message.id}")

    message.refresh_from_db()
    assert message.status == "replied"
    assert message.read_at is not None


def test_the_notes_come_back_oldest_first(signed_in):
    message = make()
    now = timezone.now()
    ContactNote.objects.create(
        message=message, text="second", created_at=now + timedelta(seconds=5)
    )
    ContactNote.objects.create(message=message, text="first", created_at=now)

    notes = signed_in.get(f"/messages/{message.id}").json()["notes"]

    assert [n["text"] for n in notes] == ["first", "second"]
    assert set(notes[0]) == {"id", "kind", "text", "created_at"}


@pytest.mark.parametrize(
    "path",
    [
        f"/messages/{PLACEHOLDER_ID}",
        "/messages/not-a-uuid",
        "/messages/1",
        "/messages/" + "0" * 36,
    ],
)
def test_a_message_that_is_not_there(signed_in, path):
    assert signed_in.get(path).status_code == 404


# Status


ALLOWED = [
    ("new", "read"),
    ("new", "replied"),
    ("new", "archived"),
    ("new", "spam"),
    ("read", "new"),
    ("read", "replied"),
    ("read", "archived"),
    ("read", "spam"),
    ("replied", "read"),
    ("replied", "archived"),
    ("replied", "spam"),
    ("archived", "new"),
    ("archived", "read"),
    ("archived", "replied"),
    ("archived", "spam"),
]
REFUSED = [
    ("replied", "new"),
    ("spam", "new"),
    ("spam", "read"),
    ("spam", "replied"),
    ("spam", "archived"),
]


@pytest.mark.parametrize("old,new", ALLOWED)
def test_allowed_status_changes(signed_in, old, new):
    message = make(old)

    response = signed_in.post(f"/messages/{message.id}/status", {"status": new})

    assert response.status_code == 200
    assert response.json()["status"] == new
    message.refresh_from_db()
    assert message.status == new
    entry = last_audit()
    assert entry.event == "message_status"
    assert entry.detail == {"id": str(message.id), "from": old, "to": new}


@pytest.mark.parametrize("old,new", REFUSED)
def test_refused_status_changes(signed_in, old, new):
    message = make(old)

    response = signed_in.post(f"/messages/{message.id}/status", {"status": new})

    assert response.status_code == 409
    message.refresh_from_db()
    assert message.status == old
    assert events() == []


def test_setting_the_same_status_is_a_quiet_no_op(signed_in):
    message = make("read")

    response = signed_in.post(f"/messages/{message.id}/status", {"status": "read"})

    assert response.status_code == 200
    assert events() == []


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"status": "trashed"},
        {"status": "NEW"},
        {"status": ""},
        {"status": None},
        {"status": 1},
        {"status": ["new"]},
        {"status": "read", "kept": True},
        {"status": "read", "id": "x"},
    ],
)
def test_a_bad_status_request_is_refused(signed_in, body):
    message = make("new")

    response = signed_in.post(f"/messages/{message.id}/status", body)

    assert response.status_code == 400
    message.refresh_from_db()
    assert message.status == "new"


def test_changing_status_leaves_everything_else(signed_in):
    message = make("new", kept=True)

    signed_in.post(f"/messages/{message.id}/status", {"status": "archived"})

    after = ContactMessage.objects.get()
    assert (after.name, after.email, after.body, after.kept) == (
        message.name,
        message.email,
        message.body,
        True,
    )
    assert after.created_at == message.created_at
    assert after.expires_at == message.expires_at


# Notes


def test_adding_a_note(signed_in):
    message = make()

    response = signed_in.post(f"/messages/{message.id}/notes", {"text": "Rang back."})

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "kind", "text", "created_at"}
    assert (body["kind"], body["text"]) == ("note", "Rang back.")
    note = ContactNote.objects.get()
    assert (note.message_id, note.text, note.kind) == (message.id, "Rang back.", "note")
    entry = last_audit()
    assert entry.event == "message_note"
    assert entry.detail == {"id": str(message.id), "note": str(note.id)}


def test_notes_are_added_never_changed(signed_in):
    message = make()
    first = signed_in.post(f"/messages/{message.id}/notes", {"text": "One"}).json()
    signed_in.post(f"/messages/{message.id}/notes", {"text": "Two"})

    texts = [
        n["text"] for n in signed_in.get(f"/messages/{message.id}").json()["notes"]
    ]

    assert texts == ["One", "Two"]
    assert ContactNote.objects.get(id=first["id"]).text == "One"


@pytest.mark.parametrize("method", ["PATCH", "GET"])
def test_a_note_has_no_edit_route(signed_in, method):
    message = make()
    note = signed_in.post(f"/messages/{message.id}/notes", {"text": "One"}).json()

    for path in (
        f"/messages/{message.id}/notes/{note['id']}",
        f"/messages/{message.id}/notes/{note['id']}/delete",
    ):
        assert signed_in.request(method, path).status_code in (404, 405)
        assert signed_in.post(path, {"text": "x"}).status_code in (404, 405)
    assert ContactNote.objects.get().text == "One"


def test_the_notes_route_takes_post_only(signed_in):
    message = make()

    assert signed_in.get(f"/messages/{message.id}/notes").status_code == 405
    assert signed_in.patch(f"/messages/{message.id}/notes", {}).status_code == 405


@pytest.mark.parametrize(
    "text",
    ["", "   ", "x" * 2001, "bad\x00char", "bad\x1bescape", None, 5, ["a"], {"a": 1}],
)
def test_a_bad_note_is_refused(signed_in, text):
    message = make()

    response = signed_in.post(f"/messages/{message.id}/notes", {"text": text})

    assert response.status_code == 400
    assert not ContactNote.objects.exists()


def test_a_note_may_be_long_and_have_new_lines(signed_in):
    message = make()
    text = "Line one.\nLine two. " + "x" * 1970

    response = signed_in.post(f"/messages/{message.id}/notes", {"text": text})

    assert response.status_code == 201
    assert ContactNote.objects.get().text == text.strip()


def test_a_note_cannot_choose_its_kind_or_message(signed_in):
    message = make()
    other = make()

    response = signed_in.post(
        f"/messages/{message.id}/notes",
        {"text": "x", "kind": "responded_with_details", "message": str(other.id)},
    )

    assert response.status_code == 400
    assert not ContactNote.objects.exists()


def test_a_note_on_a_missing_message(signed_in):
    response = signed_in.post(f"/messages/{PLACEHOLDER_ID}/notes", {"text": "x"})

    assert response.status_code == 404


# Responded with details


def test_logging_a_response_adds_a_note_and_marks_it_replied(signed_in):
    message = make("read")

    response = signed_in.post(
        f"/messages/{message.id}/responded", {"text": "Sent the full CV."}
    )

    assert response.status_code == 201
    note = ContactNote.objects.get()
    assert (note.kind, note.text) == ("responded_with_details", "Sent the full CV.")
    message.refresh_from_db()
    assert message.status == "replied"
    entry = last_audit()
    assert entry.event == "message_responded"
    assert entry.detail == {"id": str(message.id), "note": str(note.id)}


def test_logging_a_response_needs_no_text(signed_in):
    message = make("new")

    response = signed_in.post(f"/messages/{message.id}/responded", {})

    assert response.status_code == 201
    assert ContactNote.objects.get().text == "Responded with details."


@pytest.mark.parametrize("old", ["new", "read", "replied", "archived"])
def test_logging_a_response_works_from_every_state_but_spam(signed_in, old):
    message = make(old)

    assert signed_in.post(f"/messages/{message.id}/responded", {}).status_code == 201

    message.refresh_from_db()
    assert message.status == "replied"


def test_logging_a_response_on_a_quarantined_message_is_refused(signed_in):
    message = make("spam")

    response = signed_in.post(f"/messages/{message.id}/responded", {})

    assert response.status_code == 409
    assert not ContactNote.objects.exists()
    assert ContactMessage.objects.get().status == "spam"


def test_a_response_log_is_refused_if_its_text_is_wrong(signed_in):
    message = make()

    for body in ({"text": "x" * 2001}, {"text": 5}, {"kind": "note"}):
        assert (
            signed_in.post(f"/messages/{message.id}/responded", body).status_code == 400
        )
    assert not ContactNote.objects.exists()


# Keep


@pytest.mark.parametrize("kept", [True, False])
def test_keeping_a_message(signed_in, kept):
    message = make(kept=not kept)

    response = signed_in.post(f"/messages/{message.id}/keep", {"kept": kept})

    assert response.status_code == 200
    assert response.json()["kept"] is kept
    message.refresh_from_db()
    assert message.kept is kept
    entry = last_audit()
    assert (entry.event, entry.detail) == (
        "message_kept",
        {"id": str(message.id), "kept": kept},
    )


@pytest.mark.parametrize("body", [{}, {"kept": "true"}, {"kept": 1}, {"kept": None}])
def test_keep_takes_a_real_boolean(signed_in, body):
    message = make()

    assert signed_in.post(f"/messages/{message.id}/keep", body).status_code == 400
    message.refresh_from_db()
    assert message.kept is False


# Not spam


def test_not_spam_moves_a_quarantined_message_back_to_new(signed_in):
    message = make("spam")

    response = signed_in.post(f"/messages/{message.id}/not-spam")

    assert response.status_code == 200
    assert response.json()["status"] == "new"
    message.refresh_from_db()
    assert message.status == "new"
    entry = last_audit()
    assert (entry.event, entry.detail) == ("message_not_spam", {"id": str(message.id)})


@pytest.mark.parametrize("status", ["new", "read", "replied", "archived"])
def test_not_spam_on_a_message_that_is_not_spam_is_refused(signed_in, status):
    message = make(status)

    response = signed_in.post(f"/messages/{message.id}/not-spam")

    assert response.status_code == 409
    message.refresh_from_db()
    assert message.status == status
    assert events() == []


def test_not_spam_takes_no_fields(signed_in):
    message = make("spam")

    response = signed_in.post(f"/messages/{message.id}/not-spam", {"status": "read"})

    assert response.status_code == 400
    message.refresh_from_db()
    assert message.status == "spam"


# Delete: the existing vital-action flow (24-hour wait, 7-day window)


def request_delete(api, message):
    return api.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "message", "id": str(message.id)},
        },
    )


def run_delete(api, passkey, action_id):
    age_sessions(minutes=6)  # the passkey confirmation only lasts minutes
    assert api.elevate(passkey).status_code == 200
    return api.post(f"/vital-actions/{action_id}/execute")


def test_there_is_no_direct_delete_route(signed_in):
    message = make()

    response = signed_in.post(f"/messages/{message.id}/delete")

    assert response.status_code in (404, 405)
    assert ContactMessage.objects.filter(id=message.id).exists()


def test_asking_to_delete_needs_a_fresh_passkey_and_removes_nothing(signed_in):
    message = make()

    refused = request_delete(signed_in, message)

    assert refused.status_code == 403
    assert refused.json()["code"] == "elevation_required"
    assert ContactMessage.objects.filter(id=message.id).exists()


def test_a_deletion_waits_24_hours_then_removes_the_message_and_its_notes(
    elevated, passkey
):
    message = make()
    ContactNote.objects.create(message=message, text="Private note text")
    keep = make(name="Someone Else")

    requested = request_delete(elevated, message)

    assert requested.status_code == 201
    body = requested.json()
    assert body["state"] == "waiting"
    assert body["target"] == {"entity": "message", "id": str(message.id)}
    assert ContactMessage.objects.filter(id=message.id).exists()
    too_early = run_delete(elevated, passkey, body["id"])
    assert too_early.status_code == 409
    assert ContactMessage.objects.filter(id=message.id).exists()

    mature(PendingAction.objects.get(), hours=25)
    done = run_delete(elevated, passkey, body["id"])

    assert done.status_code == 200
    assert not ContactMessage.objects.filter(id=message.id).exists()
    assert not ContactNote.objects.exists()
    assert ContactMessage.objects.get().id == keep.id
    assert elevated.get(f"/messages/{message.id}").status_code == 404


def test_the_audit_entries_for_a_deletion_hold_ids_and_nothing_else(elevated, passkey):
    message = make()
    ContactNote.objects.create(message=message, text="Private note text")
    action = request_delete(elevated, message).json()["id"]
    mature(PendingAction.objects.get(), hours=25)

    run_delete(elevated, passkey, action)

    entries = AuditLog.objects.filter(event__startswith="vital_action_")
    assert [e.event for e in entries] == [
        "vital_action_requested",
        "vital_action_executed",
    ]
    for entry in entries:
        assert entry.detail["target"] == {"entity": "message", "id": str(message.id)}
    everything = json.dumps(list(AuditLog.objects.values()), default=str)
    for private in (PERSON, MAIL, WORDS, "Private note text", "Quillfeather"):
        assert private not in everything
    assert audit.verify_chain().ok


def test_a_deletion_can_be_cancelled_with_an_ordinary_session(elevated, passkey):
    message = make()
    action = request_delete(elevated, message).json()
    age_sessions(minutes=6)  # a cancel needs no fresh passkey

    cancelled = elevated.post(f"/vital-actions/{action['id']}/cancel")

    assert cancelled.status_code == 200
    mature(PendingAction.objects.get(), hours=25)
    assert run_delete(elevated, passkey, action["id"]).status_code == 409
    assert ContactMessage.objects.filter(id=message.id).exists()


def test_a_deletion_not_run_within_seven_days_expires(elevated, passkey):
    message = make()
    action = request_delete(elevated, message).json()["id"]
    mature(PendingAction.objects.get(), days=9)

    assert run_delete(elevated, passkey, action).status_code == 409
    assert ContactMessage.objects.filter(id=message.id).exists()


def test_a_pending_deletion_shows_in_the_pending_list(elevated):
    message = make()
    request_delete(elevated, message)

    (action,) = elevated.get("/vital-actions").json()["actions"]

    assert action["kind"] == "permanent_delete"
    assert action["target"] == {"entity": "message", "id": str(message.id)}
    assert action["state"] == "waiting"


def test_a_message_that_is_not_there_cannot_be_asked_for(elevated):
    response = elevated.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "message", "id": PLACEHOLDER_ID},
        },
    )

    assert response.status_code == 400
    assert not PendingAction.objects.exists()


def test_a_quarantined_or_kept_message_can_be_deleted_the_same_way(elevated, passkey):
    for message in (make("spam"), make(kept=True)):
        action = request_delete(elevated, message).json()["id"]
        mature(PendingAction.objects.get(id=action), hours=25)
        assert run_delete(elevated, passkey, action).status_code == 200
    assert not ContactMessage.objects.exists()


# Search and filters


def filtered(signed_in, **params):
    return signed_in.get("/messages", params)


def names(response):
    return sorted(r["name"] for r in response.json()["results"])


def test_search_matches_name_email_and_message_ignoring_case(signed_in):
    make(
        name="Alice Archer", email="alice@one.example", body="About the graduate role."
    )
    make(name="Bruno Baker", email="bruno@two.example", body="A short project.")

    assert names(filtered(signed_in, q="alice")) == ["Alice Archer"]
    assert names(filtered(signed_in, q="TWO.EXAMPLE")) == ["Bruno Baker"]
    assert names(filtered(signed_in, q="graduate")) == ["Alice Archer"]
    assert names(filtered(signed_in, q="nothing like it")) == []
    assert names(filtered(signed_in, q="  Bruno  ")) == ["Bruno Baker"]


def test_search_treats_wildcards_as_plain_text(signed_in):
    make(name="Percent", body="Fifty % off, honestly.")
    make(name="Plain", body="Nothing special here at all.")

    assert names(filtered(signed_in, q="%")) == ["Percent"]
    assert names(filtered(signed_in, q="_")) == []
    assert names(filtered(signed_in, q="' OR '1'='1")) == []


def test_search_follows_the_status_tab(signed_in):
    make("new", name="Alice New")
    make("spam", name="Alice Spam")

    assert names(filtered(signed_in, q="alice")) == ["Alice New"]
    assert names(filtered(signed_in, q="alice", status="spam")) == ["Alice Spam"]


def test_filter_by_reason(signed_in):
    make(name="H", reason="hiring")
    make(name="P", reason="project")
    make(name="O", reason="other")
    make(name="N", reason="")

    assert names(filtered(signed_in, reason="hiring")) == ["H"]
    assert names(filtered(signed_in, reason="project")) == ["P"]
    assert names(filtered(signed_in, reason="other")) == ["O"]
    assert names(filtered(signed_in, reason="none")) == ["N"]
    assert len(filtered(signed_in).json()["results"]) == 4


def test_filter_by_day_is_inclusive(signed_in):
    day = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)
    for name, when in (
        ("Early", day - timedelta(days=10)),
        ("Mid", day - timedelta(days=5)),
        ("Late", day - timedelta(days=1)),
    ):
        make(name=name, created_at=when)
    mid = (day - timedelta(days=5)).date().isoformat()
    late = (day - timedelta(days=1)).date().isoformat()

    assert names(filtered(signed_in, since=mid)) == ["Late", "Mid"]
    assert names(filtered(signed_in, until=mid)) == ["Early", "Mid"]
    assert names(filtered(signed_in, since=mid, until=mid)) == ["Mid"]
    assert names(filtered(signed_in, since=late, until=mid)) == []


def test_filters_combine_and_page(signed_in):
    for n in range(30):
        make(name=f"Hire {n:02d}", reason="hiring", body="graduate role")
    make(name="Other", reason="other", body="graduate role")

    body = filtered(signed_in, q="graduate", reason="hiring", page=2).json()

    assert (body["count"], body["pages"], len(body["results"])) == (30, 2, 5)


def test_the_tab_counts_ignore_the_filters(signed_in):
    make("new", name="Alice")
    make("new", name="Bruno")

    body = filtered(signed_in, q="alice").json()

    assert body["count"] == 1
    assert body["counts"]["new"] == 2


@pytest.mark.parametrize(
    "params",
    [
        {"q": "x" * 101},
        {"q": "bad\x00char"},
        {"reason": "Hiring"},
        {"reason": "spam"},
        {"reason": ""},
        {"since": "yesterday"},
        {"since": "2026-1-1"},
        {"since": "2026-13-01"},
        {"since": "2026-02-30"},
        {"since": "2026-01-01T00:00:00"},
        {"until": "01/01/2026"},
        {"until": ""},
    ],
)
def test_bad_filters_are_refused(signed_in, params):
    assert filtered(signed_in, **params).status_code == 400


def test_a_repeated_filter_is_refused(signed_in):
    assert signed_in.get("/messages?q=a&q=b").status_code == 400
    assert signed_in.get("/messages?reason=hiring&reason=other").status_code == 400


def test_the_list_and_detail_show_the_reason_and_the_spam_score(signed_in):
    message = make("spam", reason="hiring", spam_score=100)

    (row,) = signed_in.get("/messages", {"status": "spam"}).json()["results"]
    detail = signed_in.get(f"/messages/{message.id}").json()

    assert (row["reason"], row["spam_score"]) == ("hiring", 100)
    assert (detail["reason"], detail["spam_score"]) == ("hiring", 100)


# Retention


def test_marking_spam_and_not_spam_moves_the_expiry(signed_in):
    message = make("new")
    year = message.expires_at - message.created_at

    signed_in.post(f"/messages/{message.id}/status", {"status": "spam"})
    message.refresh_from_db()
    # The spam period runs from when it was marked (4B-1), not from arrival.
    assert message.expires_at - message.spam_at == timedelta(days=30)

    signed_in.post(f"/messages/{message.id}/not-spam")
    message.refresh_from_db()
    assert message.expires_at - message.created_at == timedelta(days=365)
    assert year == timedelta(days=365)


def test_the_retention_periods_start_at_30_and_365_days(signed_in):
    body = signed_in.get("/retention").json()

    assert body == {
        "spam_days": 30,
        "message_days": 365,
        "min_days": 7,
        "max_days": 3650,
    }


def test_changing_the_periods_moves_every_message(elevated):
    spam = make("spam")
    other = make("read")
    kept = make("new", kept=True)

    response = elevated.patch("/retention", {"spam_days": 7, "message_days": 100})

    assert response.status_code == 200
    assert response.json()["spam_days"] == 7
    for row, days in ((spam, 7), (other, 100), (kept, 100)):
        row.refresh_from_db()
        assert row.expires_at - row.created_at == timedelta(days=days)
    assert elevated.get("/retention").json()["message_days"] == 100
    entry = last_audit()
    assert (entry.event, entry.detail) == (
        "retention_changed",
        {"spam_days": 7, "message_days": 100},
    )


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"spam_days": 7},
        {"message_days": 7},
        {"spam_days": 0, "message_days": 7},
        {"spam_days": 6, "message_days": 7},
        {"spam_days": 7, "message_days": 6},
        {"spam_days": 7, "message_days": 3651},
        {"spam_days": -1, "message_days": 7},
        {"spam_days": "7", "message_days": 7},
        {"spam_days": 7.5, "message_days": 7},
        {"spam_days": True, "message_days": 7},
        {"spam_days": None, "message_days": 7},
        {"spam_days": 7, "message_days": 7, "kept": True},
    ],
)
def test_bad_periods_are_refused_and_change_nothing(elevated, body):
    message = make("spam")

    response = elevated.patch("/retention", body)

    assert response.status_code == 400
    assert elevated.get("/retention").json()["spam_days"] == 30
    message.refresh_from_db()
    assert message.expires_at - message.created_at == timedelta(days=30)


def test_the_periods_are_not_in_the_public_site(elevated, client):
    saved = elevated.patch("/retention", {"spam_days": 7, "message_days": 100})
    assert saved.status_code == 200

    body = client.get("/api/v1/site", secure=True).content.decode()

    assert "retention" not in body


def test_saving_the_periods_and_their_audit_entry_stand_or_fall_together(
    elevated, monkeypatch
):
    message = make("spam")

    def broken(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(audit, "record", broken)

    with pytest.raises(RuntimeError):
        elevated.patch("/retention", {"spam_days": 7, "message_days": 100})

    assert elevated.get("/retention").json()["spam_days"] == 30
    message.refresh_from_db()


def test_saving_the_periods_needs_a_confirmed_passkey(signed_in):
    message = make("spam")
    before = AuditLog.objects.count()

    response = signed_in.patch("/retention", {"spam_days": 7, "message_days": 100})

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert signed_in.get("/retention").json()["spam_days"] == 30
    message.refresh_from_db()
    assert message.expires_at - message.created_at == timedelta(days=30)
    assert AuditLog.objects.count() == before


def test_reading_the_periods_needs_only_a_session(signed_in):
    response = signed_in.get("/retention")

    assert response.status_code == 200
    assert response.json()["spam_days"] == 30


def test_seven_days_is_the_shortest_period(elevated):
    response = elevated.patch("/retention", {"spam_days": 7, "message_days": 7})

    assert response.status_code == 200
    assert (response.json()["spam_days"], response.json()["message_days"]) == (7, 7)


# Audit


def test_no_audit_entry_holds_message_content(signed_in):
    message = make()
    other = make("spam")
    signed_in.get(f"/messages/{message.id}")
    signed_in.post(f"/messages/{message.id}/notes", {"text": "Private note text"})
    signed_in.post(f"/messages/{message.id}/responded", {"text": "Private reply text"})
    signed_in.post(f"/messages/{message.id}/status", {"status": "archived"})
    signed_in.post(f"/messages/{message.id}/keep", {"kept": True})
    signed_in.post(f"/messages/{other.id}/not-spam")

    assert events().count("message_read") == 1
    assert {
        "message_read",
        "message_note",
        "message_responded",
        "message_status",
        "message_kept",
        "message_not_spam",
    } <= set(events())
    everything = json.dumps(list(AuditLog.objects.values()), default=str)
    for private in (
        PERSON,
        MAIL,
        WORDS,
        "Private note text",
        "Private reply text",
        "marmalade",
    ):
        assert private not in everything
    assert audit.verify_chain().ok


def test_a_change_and_its_audit_entry_stand_or_fall_together(signed_in, monkeypatch):
    message = make("new")

    def broken(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(audit, "record", broken)

    for path, body in (
        (f"/messages/{message.id}/status", {"status": "archived"}),
        (f"/messages/{message.id}/notes", {"text": "x"}),
        (f"/messages/{message.id}/responded", {}),
        (f"/messages/{message.id}/keep", {"kept": True}),
    ):
        with pytest.raises(RuntimeError):
            signed_in.post(path, body)

    after = ContactMessage.objects.get()
    assert (after.status, after.kept) == ("new", False)
    assert not ContactNote.objects.exists()


def test_a_first_view_and_its_audit_entry_stand_or_fall_together(
    signed_in, monkeypatch
):
    message = make("new")

    def broken(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(audit, "record", broken)

    with pytest.raises(RuntimeError):
        signed_in.get(f"/messages/{message.id}")

    message.refresh_from_db()
    assert (message.status, message.read_at) == ("new", None)


def test_the_serializer_uses_the_same_limits_as_retention():
    from core import retention, serializers

    for name in ("spam_days", "message_days"):
        field = serializers.Retention().fields[name]
        assert (field.min_value, field.max_value) == (
            retention.MIN_DAYS,
            retention.MAX_DAYS,
        )
