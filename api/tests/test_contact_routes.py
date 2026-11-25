"""The contact routes under /api/v1/admin/contacts: levels, limits on every
field, one contact per email, no hash in any answer, audit with ids only."""

from datetime import timedelta

import pytest
from django.utils import timezone

from core import audit, contact
from core.models import AuditLog, Contact
from tests.conftest import new_message
from tests.test_contacts import EMAIL, NAME, new_contact

pytestmark = pytest.mark.django_db

ORG = "Halverton Recruitment"
NOTES = "Met at the careers fair, wants a call in spring."
GOOD = {"organisation": ORG, "tags": ["recruiter"], "notes": NOTES}
MISSING = "00000000-0000-4000-8000-000000000000"


def made(api, message, **fields):
    return api.post("/contacts", {"message": str(message.id), **fields})


def no_hash_in(response):
    said = response.content.decode()
    assert "email_hash" not in said
    for value in Contact.objects.values_list("email_hash", flat=True):
        assert value not in said
    assert contact.email_hash(EMAIL) not in said


def the_contact(api, **fields):
    made(api, new_message(name=NAME, email=EMAIL), **fields)
    return Contact.objects.get()


# Creating


def test_create_from_a_message_copies_the_sender_and_links_it(signed_in):
    message = new_message(name=NAME, email=EMAIL)

    response = made(
        signed_in,
        message,
        organisation=ORG,
        tags=["recruiter", "spring"],
        notes=NOTES,
        follow_up="2027-03-01",
    )

    assert response.status_code == 201
    body = response.json()
    person = Contact.objects.get()
    assert (person.name, person.email, person.organisation) == (NAME, EMAIL, ORG)
    assert person.tags == ["recruiter", "spring"]
    assert person.follow_up.isoformat() == "2027-03-01"
    message.refresh_from_db()
    assert message.contact_id == person.id
    assert [m["id"] for m in body["messages"]] == [str(message.id)]
    assert set(body) == {
        "id",
        "name",
        "email",
        "organisation",
        "tags",
        "follow_up",
        "created_at",
        "updated_at",
        "notes",
        "messages",
    }
    no_hash_in(response)


def test_a_second_contact_for_the_same_email_is_refused(signed_in):
    made(signed_in, new_message(email=EMAIL))
    again = new_message(email=" " + EMAIL.upper())

    response = made(signed_in, again)

    assert response.status_code == 409
    assert response.json()["code"] == "contact_exists"
    assert Contact.objects.count() == 1
    again.refresh_from_db()
    assert again.contact_id is None


def test_create_from_a_missing_message_is_not_found(signed_in):
    response = signed_in.post("/contacts", {"message": MISSING})

    assert response.status_code == 404
    assert Contact.objects.count() == 0


@pytest.mark.parametrize(
    "fields",
    [
        {"organisation": "x" * 101},
        {"organisation": 5},
        {"organisation": "a\nb"},
        {"tags": ["t"] * 11},
        {"tags": ["x" * 31]},
        {"tags": [""]},
        {"tags": ["  "]},
        {"tags": "recruiter"},
        {"tags": [5]},
        {"tags": ["a\nb"]},
        {"notes": "x" * 5001},
        {"notes": ["x"]},
        {"follow_up": "1999-12-31"},
        {"follow_up": "2100-01-01"},
        {"follow_up": "2027-02-30"},
        {"follow_up": "2027-03-01T10:00:00Z"},
        {"follow_up": 20270301},
        {"name": "Someone else"},
        {"email": "other@example.org"},
        {"email_hash": "f" * 64},
        {"extra": 1},
    ],
)
def test_bad_fields_on_create_are_refused(signed_in, fields):
    response = made(signed_in, new_message(email=EMAIL), **fields)

    assert response.status_code == 400
    assert Contact.objects.count() == 0


@pytest.mark.parametrize("body", [{}, {"message": "not-an-id"}, {"message": 5}])
def test_create_needs_a_message_id(signed_in, body):
    assert signed_in.post("/contacts", body).status_code == 400


def test_every_field_at_its_limit_is_accepted(signed_in):
    fields = {
        "organisation": "o" * 100,
        "tags": [f"{n:02d}" + "t" * 28 for n in range(10)],
        "notes": "n" * 5000,
        "follow_up": "2099-12-31",
    }

    person = the_contact(signed_in, **fields)

    assert (len(person.tags), len(person.notes)) == (10, 5000)
    edit = signed_in.patch(
        f"/contacts/{person.id}", {"name": "x" * 100, "follow_up": "2000-01-01"}
    )
    assert edit.status_code == 200


def test_repeated_tags_are_kept_once(signed_in):
    person = the_contact(signed_in, tags=["recruiter", "recruiter", "x"])

    assert person.tags == ["recruiter", "x"]


# Editing


def test_edit_changes_only_the_fields_sent(signed_in):
    person = the_contact(signed_in, **GOOD)

    response = signed_in.patch(
        f"/contacts/{person.id}", {"notes": "Called back.", "follow_up": None}
    )

    assert response.status_code == 200
    person.refresh_from_db()
    assert (person.name, person.organisation, person.notes) == (
        NAME,
        ORG,
        "Called back.",
    )
    assert person.follow_up is None
    no_hash_in(response)


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"name": ""},
        {"name": "x" * 101},
        {"name": "a\nb"},
        {"email": "other@example.org"},
        {"email_hash": "f" * 64},
        {"tags": ["x" * 31]},
        {"follow_up": "soon"},
        {"messages": []},
        {"created_at": "2020-01-01T00:00:00Z"},
    ],
)
def test_bad_edits_are_refused(signed_in, body):
    person = the_contact(signed_in, **GOOD)

    assert signed_in.patch(f"/contacts/{person.id}", body).status_code == 400
    person.refresh_from_db()
    assert (person.name, person.email, person.tags) == (NAME, EMAIL, ["recruiter"])


def test_reading_or_editing_a_missing_contact_is_not_found(signed_in):
    assert signed_in.patch(f"/contacts/{MISSING}", {"notes": "x"}).status_code == 404
    assert signed_in.get(f"/contacts/{MISSING}").status_code == 404


def test_detail_shows_notes_and_messages_but_no_hash(signed_in):
    person = the_contact(signed_in, **GOOD)

    response = signed_in.get(f"/contacts/{person.id}")

    assert response.status_code == 200
    assert response.json()["notes"] == NOTES
    assert len(response.json()["messages"]) == 1
    no_hash_in(response)


# Linking


def test_link_and_unlink_a_message_from_the_same_sender(signed_in):
    person = the_contact(signed_in)
    later = new_message(email=EMAIL.upper(), body="A second message, later on.")

    linked = signed_in.post(f"/contacts/{person.id}/link", {"message": str(later.id)})

    assert linked.status_code == 200
    later.refresh_from_db()
    assert later.contact_id == person.id
    assert len(linked.json()["messages"]) == 2

    unlinked = signed_in.post(
        f"/contacts/{person.id}/unlink", {"message": str(later.id)}
    )

    assert unlinked.status_code == 200
    later.refresh_from_db()
    assert later.contact_id is None
    no_hash_in(unlinked)


def test_a_message_from_another_email_cannot_be_linked(signed_in):
    person = the_contact(signed_in)
    other = new_message(email="someone.else@example.org")

    response = signed_in.post(f"/contacts/{person.id}/link", {"message": str(other.id)})

    assert response.status_code == 409
    assert response.json()["code"] == "different_sender"
    other.refresh_from_db()
    assert other.contact_id is None


@pytest.mark.parametrize(
    "body", [{}, {"message": "not-an-id"}, {"message": 5}, {"message": MISSING, "y": 1}]
)
def test_a_bad_link_is_refused(signed_in, body):
    person = the_contact(signed_in)

    assert signed_in.post(f"/contacts/{person.id}/link", body).status_code == 400
    assert signed_in.post(f"/contacts/{person.id}/unlink", body).status_code == 400


def test_linking_to_a_missing_contact_or_message_is_not_found(signed_in):
    person = the_contact(signed_in)
    message = new_message(email=EMAIL)

    to_missing = signed_in.post(
        f"/contacts/{MISSING}/link", {"message": str(message.id)}
    )
    missing_message = signed_in.post(
        f"/contacts/{person.id}/link", {"message": MISSING}
    )

    assert (to_missing.status_code, missing_message.status_code) == (404, 404)


# Deleting


def test_delete_needs_a_fresh_passkey_and_keeps_the_messages(elevated):
    message = new_message(email=EMAIL)
    made(elevated, message)
    person = Contact.objects.get()

    response = elevated.post(f"/contacts/{person.id}/delete")

    assert response.status_code == 200
    assert Contact.objects.count() == 0
    message.refresh_from_db()
    assert message.contact_id is None
    assert elevated.post(f"/contacts/{person.id}/delete").status_code == 404


def test_delete_takes_no_fields(elevated):
    person = the_contact(elevated)

    response = elevated.post(f"/contacts/{person.id}/delete", {"id": str(person.id)})

    assert response.status_code == 400
    assert Contact.objects.count() == 1


# Who may do what


def test_a_session_alone_cannot_delete(signed_in):
    person = the_contact(signed_in)

    response = signed_in.post(f"/contacts/{person.id}/delete")

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert Contact.objects.count() == 1


def test_no_session_sees_or_changes_nothing(api, passkey):
    person = new_contact(notes=NOTES)
    message = new_message(email=EMAIL)

    responses = [
        api.get("/contacts"),
        api.get(f"/contacts/{person.id}"),
        api.post("/contacts", {"message": str(message.id)}),
        api.patch(f"/contacts/{person.id}", {"notes": "x"}),
        api.post(f"/contacts/{person.id}/link", {"message": str(message.id)}),
        api.post(f"/contacts/{person.id}/unlink", {"message": str(message.id)}),
        api.post(f"/contacts/{person.id}/delete"),
    ]

    assert {r.status_code for r in responses} == {401}
    for response in responses:
        assert NOTES not in response.content.decode()
        assert EMAIL not in response.content.decode()
    person.refresh_from_db()
    assert person.notes == NOTES
    assert Contact.objects.count() == 1


def test_each_route_has_the_level_it_needs():
    from core import admin_urls
    from core.authz import Level

    views = {str(p.pattern): p.callback for p in admin_urls.urlpatterns}

    assert views["contacts"].admin_levels == {
        "GET": Level.SESSION,
        "POST": Level.SESSION,
    }
    assert views["contacts/<uuid:contact_id>"].admin_levels == {
        "GET": Level.SESSION,
        "PATCH": Level.SESSION,
    }
    for path in ("link", "unlink"):
        assert views[f"contacts/<uuid:contact_id>/{path}"].admin_levels == {
            "POST": Level.SESSION
        }
    assert views["contacts/<uuid:contact_id>/delete"].admin_levels == {
        "POST": Level.ELEVATED
    }


# The list


def test_the_list_pages_by_25_and_never_shows_a_hash(signed_in):
    for n in range(30):
        new_contact(email=f"person{n}@example.org", name=f"Person {n:02d}")

    first = signed_in.get("/contacts")
    second = signed_in.get("/contacts", {"page": "2"})

    assert first.status_code == 200
    assert (first.json()["count"], first.json()["pages"]) == (30, 2)
    assert len(first.json()["results"]) == 25
    assert len(second.json()["results"]) == 5
    assert "notes" not in first.json()["results"][0]
    no_hash_in(first)


def found(api, params):
    rows = api.get("/contacts", params).json()["results"]
    return {row["id"] for row in rows}


def test_search_by_name_organisation_or_email(signed_in):
    a = new_contact(email="ada@one.example", name="Ada Lovell")
    b = new_contact(email="bo@two.example", name="Bo", organisation="Halverton")
    c = new_contact(email="cy@three.example", name="Cy")

    assert found(signed_in, {"q": "lovell"}) == {str(a.id)}
    assert found(signed_in, {"q": "HALVERTON"}) == {str(b.id)}
    assert found(signed_in, {"q": "three.example"}) == {str(c.id)}


def test_filter_by_tag_and_by_follow_up_due(signed_in):
    today = timezone.now().date()
    due = new_contact(email="a@x.example", tags=["recruiter"], follow_up=today)
    late = new_contact(email="b@x.example", follow_up=today - timedelta(days=3))
    later = new_contact(
        email="c@x.example", tags=["recruiter"], follow_up=today + timedelta(days=1)
    )
    new_contact(email="d@x.example", tags=["employer"], follow_up=None)

    assert found(signed_in, {"tag": "recruiter"}) == {str(due.id), str(later.id)}
    assert found(signed_in, {"due": "1"}) == {str(due.id), str(late.id)}
    assert found(signed_in, {"tag": "recruiter", "due": "1"}) == {str(due.id)}


@pytest.mark.parametrize(
    "params",
    [
        {"q": "x" * 101},
        {"q": "a\x00b"},
        {"tag": "x" * 31},
        {"due": "yes"},
        {"due": "0"},
        {"page": "0"},
        {"sort": "name"},
    ],
)
def test_a_bad_list_query_is_refused(signed_in, params):
    assert signed_in.get("/contacts", params).status_code == 400


# Audit


def test_audit_entries_hold_the_contact_id_and_field_names_only(elevated):
    message = new_message(name=NAME, email=EMAIL, body="A private body here.")
    made(elevated, message, **GOOD)
    person = Contact.objects.get()
    elevated.patch(f"/contacts/{person.id}", {"notes": "Second private note."})
    later = new_message(email=EMAIL)
    elevated.post(f"/contacts/{person.id}/link", {"message": str(later.id)})
    elevated.post(f"/contacts/{person.id}/unlink", {"message": str(later.id)})
    elevated.post(f"/contacts/{person.id}/delete")

    rows = AuditLog.objects.filter(event__startswith="contact_").order_by("seq")
    assert [(r.event, r.detail) for r in rows] == [
        ("contact_created", {"id": str(person.id)}),
        ("contact_changed", {"id": str(person.id), "fields": ["notes"]}),
        ("contact_message_linked", {"id": str(person.id)}),
        ("contact_message_unlinked", {"id": str(person.id)}),
        ("contact_deleted", {"id": str(person.id)}),
    ]
    said = str(list(AuditLog.objects.values("event", "detail")))
    for private in (
        NAME,
        EMAIL,
        ORG,
        NOTES,
        "Second private note.",
        "A private body here.",
        "recruiter",
        contact.email_hash(EMAIL),
    ):
        assert private not in said
    assert audit.verify_chain().ok


def test_an_edit_that_changes_nothing_writes_no_entry(signed_in):
    person = the_contact(signed_in, **GOOD)

    signed_in.patch(f"/contacts/{person.id}", {"organisation": ORG})

    assert not AuditLog.objects.filter(event="contact_changed").exists()
