"""Migration 0013 (contact messages) and the reversal of 0012 (project slugs)."""

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

pytestmark = pytest.mark.django_db

BEFORE_CONTACT = [("core", "0012_project_slugs")]
CONTACT = [("core", "0013_contact_messages")]
BEFORE_SLUGS = [("core", "0011_default_palette_a")]
SLUGS = [("core", "0012_project_slugs")]
PROJECT = {"title": "Task board", "summary": "A board."}


def migrate(target):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(target)
    return executor.loader.project_state(target).apps


def tables():
    with connection.cursor() as cursor:
        return set(connection.introspection.table_names(cursor))


def columns(table):
    with connection.cursor() as cursor:
        description = connection.introspection.get_table_description(cursor, table)
    return {column.name for column in description}


@pytest.fixture
def at_latest():
    yield
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


def settle():
    # Postgres will not alter a table with foreign-key checks still queued.
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_0013_makes_both_tables_and_reverses_cleanly(at_latest):
    assert {"contact_messages", "contact_notes"} <= tables()

    migrate(BEFORE_CONTACT)

    assert not {"contact_messages", "contact_notes"} & tables()

    apps = migrate(CONTACT)
    message = apps.get_model("core", "ContactMessage")
    note = apps.get_model("core", "ContactNote")
    row = message.objects.create(
        name="A",
        email="a@example.com",
        body="Hello there, a message.",
        expires_at="2030-01-01T00:00:00Z",
    )
    note.objects.create(message=row, text="Seen")
    assert message.objects.get().status == "new"
    assert message.objects.get().kept is False
    assert columns("contact_messages") >= {
        "id", "name", "email", "body", "status", "created_at", "read_at",
        "kept", "expires_at", "ip_hash",
    }  # fmt: skip
    assert columns("contact_notes") >= {
        "id",
        "message_id",
        "text",
        "kind",
        "created_at",
    }


def test_0013_leaves_earlier_data_alone(at_latest):
    apps = migrate(BEFORE_CONTACT)
    Section = apps.get_model("core", "Section")
    section = Section.objects.create(type="text", position=0, draft={"title": "T"})
    settle()

    apps = migrate(CONTACT)

    assert apps.get_model("core", "Section").objects.get(id=section.id).draft == {
        "title": "T"
    }


def test_0012_reverses_cleanly(at_latest):
    apps = migrate(BEFORE_SLUGS)
    Section = apps.get_model("core", "Section")
    Item = apps.get_model("core", "SectionItem")
    section = Section.objects.create(type="projects", position=0)
    item = Item.objects.create(section=section, position=0, draft=PROJECT)
    section.published = {
        "type": "projects",
        "title": "Work",
        "items": [{"id": str(item.id), "data": PROJECT}],
    }
    section.save()
    settle()
    apps = migrate(SLUGS)
    section = apps.get_model("core", "Section").objects.get(id=section.id)
    assert section.published["items"][0]["slug"] == "task-board"
    assert "slug" in columns("section_items")
    settle()

    apps = migrate(BEFORE_SLUGS)

    section = apps.get_model("core", "Section").objects.get(id=section.id)
    assert "slug" not in section.published["items"][0]
    assert section.published["items"][0]["data"] == PROJECT
    assert "slug" not in columns("section_items")

    # And forwards again gives the same address back.
    settle()
    apps = migrate(SLUGS)
    section = apps.get_model("core", "Section").objects.get(id=section.id)
    assert section.published["items"][0]["slug"] == "task-board"


# Migrations 0014 (reason, spam score, retention periods) and 0015 (old table)

AFTER_CONTACT = [("core", "0013_contact_messages")]
FIELDS = [("core", "0014_contact_reason_score_retention")]
DROP_OLD = [("core", "0015_drop_old_messages")]


def test_0014_adds_the_fields_with_safe_defaults_and_reverses(at_latest):
    apps = migrate(AFTER_CONTACT)
    message = apps.get_model("core", "ContactMessage").objects.create(
        name="A",
        email="a@example.com",
        body="Hello there, a message.",
        expires_at="2030-01-01T00:00:00Z",
    )
    settle()
    assert "reason" not in columns("contact_messages")
    assert "retention_spam_days" not in columns("site_settings")

    apps = migrate(FIELDS)

    row = apps.get_model("core", "ContactMessage").objects.get(id=message.id)
    assert (row.reason, row.spam_score) == ("", 0)
    assert columns("contact_messages") >= {"reason", "spam_score"}
    assert columns("site_settings") >= {"retention_spam_days", "retention_message_days"}
    settings_row = apps.get_model("core", "SiteSettings").objects.create()
    assert (settings_row.retention_spam_days, settings_row.retention_message_days) == (
        30,
        365,
    )
    settings_row.delete()
    settle()

    apps = migrate(AFTER_CONTACT)

    assert "reason" not in columns("contact_messages")
    assert "spam_score" not in columns("contact_messages")
    assert "retention_spam_days" not in columns("site_settings")
    assert "retention_message_days" not in columns("site_settings")
    assert apps.get_model("core", "ContactMessage").objects.filter(id=message.id)


def test_0015_drops_the_old_table_and_reverses(at_latest):
    migrate(FIELDS)
    assert "messages" in tables()

    migrate(DROP_OLD)

    assert "messages" not in tables()
    assert "contact_messages" in tables()

    migrate(FIELDS)

    assert "messages" in tables()
    assert columns("messages") >= {"name", "email", "body", "status", "is_spam"}
