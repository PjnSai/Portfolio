from contextlib import contextmanager
from pathlib import Path

import pytest
from django.apps import apps
from django.db import ProgrammingError, connection, transaction

from core import audit
from core.models import AuditLog, ContactMessage, ContactNote, Message, Owner

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


def test_app_role_can_manage_messages(roles):
    with as_app():
        message = Message.objects.create(name="A", email="a@example.com", body="Hi")
        message.status = Message.Status.ARCHIVED
        message.notes = [{"at": "2026-01-01T00:00:00Z", "text": "Replied"}]
        message.save()
        message.delete()

        assert Message.objects.count() == 0


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
