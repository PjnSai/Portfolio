from contextlib import contextmanager
from pathlib import Path

import pytest
from django.apps import apps
from django.db import ProgrammingError, connection, transaction

from core import audit
from core.models import AuditLog, ContactMessage, ContactNote, Owner

SQL = Path(__file__).resolve().parent.parent / "db"

pytestmark = pytest.mark.django_db


@pytest.fixture
def roles():
    with connection.cursor() as cursor:
        cursor.execute((SQL / "roles.sql").read_text())
        cursor.execute((SQL / "grants.sql").read_text())


@contextmanager
def as_role(statement):
    with connection.cursor() as cursor:
        cursor.execute(statement)
        try:
            yield cursor
        finally:
            cursor.execute("RESET ROLE")


def as_app():
    return as_role("SET ROLE app_rw")


def as_migrator():
    return as_role("SET ROLE migrator")


def denied(cursor, sql):
    with pytest.raises(ProgrammingError), transaction.atomic():
        cursor.execute(sql)


def test_app_role_can_read_every_table(roles):
    with as_app():
        for model in apps.get_app_config("core").get_models():
            assert model.objects.count() >= 0


def test_app_role_can_only_append_to_the_audit_log(roles):
    with as_app() as cursor:
        audit.record("login")
        assert AuditLog.objects.count() == 1
        denied(cursor, "UPDATE audit_log SET event = 'changed'")
        denied(cursor, "DELETE FROM audit_log")
        denied(cursor, "TRUNCATE audit_log")


def test_app_role_cannot_change_the_schema(roles):
    with as_app() as cursor:
        denied(cursor, "CREATE TABLE scratch (id int)")
        denied(cursor, "DROP TABLE audit_log")
        denied(cursor, "ALTER TABLE projects ADD COLUMN extra text")
        denied(cursor, "ALTER TABLE audit_log DISABLE TRIGGER USER")
        denied(cursor, "SELECT * FROM django_migrations")


def test_app_role_can_add_contact_notes_but_not_change_them(roles):
    with as_app() as cursor:
        message = ContactMessage.objects.create(
            name="A",
            email="a@example.com",
            body="Hello there.",
            expires_at="2030-01-01T00:00:00Z",
        )
        message.status = ContactMessage.Status.READ
        message.save()
        ContactNote.objects.create(message=message, text="Seen")
        denied(cursor, "UPDATE contact_notes SET text = 'changed'")
        denied(cursor, "TRUNCATE contact_notes")

        message.delete()

        assert ContactNote.objects.count() == 0


def test_app_role_can_run_the_retention_job_but_not_change_the_audit_log(roles):
    from datetime import timedelta

    from django.core.management import call_command
    from django.utils import timezone

    past = timezone.now() - timedelta(days=1)
    with as_app() as cursor:
        gone = ContactMessage.objects.create(
            name="A", email="a@example.com", body="Hello there.", expires_at=past
        )
        noted = ContactMessage.objects.create(
            name="B", email="b@example.com", body="Hello again.", expires_at=past
        )
        ContactNote.objects.create(message=noted, text="Keep")

        call_command("run_retention")

        assert set(ContactMessage.objects.values_list("id", flat=True)) == {noted.id}
        assert AuditLog.objects.filter(event="retention_run").count() == 1
        denied(cursor, "UPDATE audit_log SET detail = '{}'")
        denied(cursor, "DELETE FROM audit_log WHERE event = 'retention_run'")
    assert gone.id not in set(ContactMessage.objects.values_list("id", flat=True))


def test_app_role_cannot_add_remove_or_rekey_the_owner(roles):
    with as_app() as cursor:
        denied(cursor, "INSERT INTO admin_owner (id) VALUES (gen_random_uuid())")
        denied(cursor, "DELETE FROM admin_owner")
        denied(cursor, "TRUNCATE admin_owner")
        denied(cursor, "UPDATE admin_owner SET singleton = false")
        denied(cursor, "UPDATE admin_owner SET id = gen_random_uuid()")
        cursor.execute("UPDATE admin_owner SET recovery_key_hash = ''")

    assert Owner.objects.count() == 1


def test_migrator_can_change_the_schema(roles):
    with as_migrator() as cursor:
        cursor.execute("CREATE TABLE scratch (id int)")
        cursor.execute("DROP TABLE scratch")


def test_app_role_can_manage_sections_and_items(roles):
    from core.models import Section, SectionItem

    with as_app():
        section = Section.objects.create(type="projects", draft={"title": "P"})
        item = SectionItem.objects.create(section=section, draft={"title": "I"})
        item.visible = False
        item.save()
        section.delete()

        assert SectionItem.objects.count() == 0


def test_app_role_can_block_renew_and_unblock_but_never_rewrite_a_hash(roles):
    from datetime import timedelta

    from django.utils import timezone

    from core import blocklist, retention
    from core.models import BlockedSender

    with as_app() as cursor:
        message = ContactMessage.objects.create(
            name="A",
            email="a@example.com",
            body="Hello there.",
            expires_at=timezone.now() + timedelta(days=1),
        )
        entry, message = blocklist.block_message(message.id, "note")
        assert message.status == ContactMessage.Status.SPAM
        blocklist.renew(entry.id)
        assert blocklist.is_blocked("a@example.com")
        denied(cursor, "UPDATE blocked_senders SET email_hash = 'other'")
        denied(cursor, "UPDATE blocked_senders SET created_at = now()")
        denied(cursor, "TRUNCATE blocked_senders")
        assert blocklist.remove(entry.id)

        BlockedSender.objects.create(
            email_hash="f" * 64, expires_at=timezone.now() - timedelta(days=1)
        )
        assert retention.run()["blocklist_deleted"] == 1
        assert BlockedSender.objects.count() == 0


def test_app_role_can_delete_everything_about_an_email_and_nothing_more(roles):
    from datetime import timedelta

    from django.utils import timezone

    from core import blocklist, contact, erase

    later = timezone.now() + timedelta(days=1)
    with as_app() as cursor:
        theirs = ContactMessage.objects.create(
            name="A", email="a@example.com", body="Hello there.", expires_at=later
        )
        ContactNote.objects.create(message=theirs, text="Noted")
        other = ContactMessage.objects.create(
            name="B", email="b@example.com", body="Hello again.", expires_at=later
        )
        blocklist.block_email("a@example.com")

        result = erase.run(
            {"email_hash": contact.email_hash("a@example.com"), "also_block": False}
        )

        assert result == {
            "messages": 1,
            "notes": 1,
            "contacts": 0,
            "unblocked": 1,
            "blocked": False,
        }
        assert list(ContactMessage.objects.values_list("id", flat=True)) == [other.id]
        denied(cursor, "TRUNCATE contact_messages")
        denied(cursor, "TRUNCATE contact_notes")
        denied(cursor, "DELETE FROM audit_log")


def test_app_role_can_keep_contacts_and_nothing_more(roles):
    from datetime import timedelta

    from django.utils import timezone

    from core import retention
    from core.models import Contact

    past = timezone.now() - timedelta(days=1)
    with as_app() as cursor:
        person = Contact.objects.create(name="A", email="a@example.com")
        message = ContactMessage.objects.create(
            name="A",
            email="a@example.com",
            body="Hello there.",
            expires_at=past,
            contact=person,
        )
        person.notes = "Met at the careers fair."
        person.save()

        assert retention.run()["deleted"] == 0
        person.delete()
        assert ContactMessage.objects.get(id=message.id).contact_id is None
        denied(cursor, "TRUNCATE contacts")
        denied(cursor, "ALTER TABLE contacts ADD COLUMN extra text")
        denied(cursor, "ALTER TABLE contact_messages DROP COLUMN contact_id")
