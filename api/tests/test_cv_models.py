"""CV tables (migration 0022): versions with one live at a time, a view log
that holds no personal data, day counts, the message kind and the switches."""

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from core.models import (
    ContactMessage,
    CvDayCount,
    CvVersion,
    CvView,
    SiteSettings,
)
from tests.conftest import new_message

pytestmark = pytest.mark.django_db

BEFORE = [("core", "0021_blocklist_address_hits")]
CV = [("core", "0022_cv")]
DOWNLOAD = [("core", "0023_cv_instant_download")]


def version(**fields):
    import secrets

    values = {
        "storage_key": f"cv/{secrets.token_hex(16)}.pdf",
        "size": 1234,
        "sha256": "a" * 64,
    }
    values.update(fields)
    return CvVersion.objects.create(**values)


def columns(table):
    with connection.cursor() as cursor:
        description = connection.introspection.get_table_description(cursor, table)
    return {column.name for column in description}


def tables():
    with connection.cursor() as cursor:
        return set(connection.introspection.table_names(cursor))


def test_a_new_version_is_not_live():
    assert version().is_live is False


def test_only_one_version_can_be_live():
    version(is_live=True)

    with pytest.raises(IntegrityError), transaction.atomic():
        version(is_live=True)


def test_many_versions_can_be_not_live():
    version()
    version()

    assert CvVersion.objects.filter(is_live=False).count() == 2


def test_the_view_log_has_no_address_email_or_free_text():
    assert columns("cv_views") == {
        "id",
        "at",
        "version",
        "kind",
        "country",
        "user_agent",
    }


def test_a_logged_view_is_a_view_unless_marked():
    row = CvView.objects.create(version="00000000-0000-4000-8000-000000000000")

    assert row.kind == CvView.Kind.VIEW
    assert set(CvView.Kind.values) == {"view", "download"}


def test_the_view_log_limits_its_fields():
    fields = {field.name: field for field in CvView._meta.get_fields()}

    assert fields["country"].max_length == 2
    assert fields["user_agent"].max_length == 200


def test_the_view_log_survives_its_version_being_deleted():
    shown = version()
    CvView.objects.create(version=shown.id, country="GB", user_agent="Browser")

    shown.delete()

    assert CvView.objects.count() == 1


def test_a_day_has_one_count():
    day = timezone.now().date()
    CvDayCount.objects.create(day=day, count=3)

    with pytest.raises(IntegrityError), transaction.atomic():
        CvDayCount.objects.create(day=day, count=1)


def test_a_message_is_a_normal_message_unless_marked():
    assert new_message().kind == ContactMessage.Kind.MESSAGE
    assert set(ContactMessage.Kind.values) == {"message", "cv_request"}


def test_all_three_switches_are_on_by_default():
    row = SiteSettings.objects.create()

    assert (
        row.cv_view_enabled,
        row.cv_request_enabled,
        row.cv_instant_download_enabled,
    ) == (True, True, True)


def test_the_unused_cv_files_table_is_gone():
    assert "cv_files" not in tables()


@pytest.fixture
def at_latest():
    yield
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


def migrate(target):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(target)
    return executor.loader.project_state(target).apps


@pytest.mark.usefixtures("at_latest")
def test_existing_messages_and_settings_get_the_defaults():
    old = migrate(BEFORE)
    message = old.get_model("core", "ContactMessage").objects.create(
        name="A",
        email="a@example.com",
        body="Hello there.",
        expires_at=timezone.now(),
    )
    row = old.get_model("core", "SiteSettings").objects.create()
    # Postgres will not alter a table with foreign-key checks still queued.
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    new = migrate(CV)

    assert new.get_model("core", "ContactMessage").objects.get(id=message.id).kind == (
        "message"
    )
    settings_row = new.get_model("core", "SiteSettings").objects.get(id=row.id)
    assert (settings_row.cv_view_enabled, settings_row.cv_request_enabled) == (
        True,
        True,
    )


@pytest.mark.usefixtures("at_latest")
def test_the_migration_reverses():
    migrate(CV)
    migrate(BEFORE)

    assert "cv_files" in tables()
    assert not {"cv_versions", "cv_views", "cv_day_counts"} & tables()
    assert "kind" not in columns("contact_messages")


@pytest.mark.usefixtures("at_latest")
def test_existing_settings_and_views_get_the_new_defaults():
    old = migrate(CV)
    row = old.get_model("core", "SiteSettings").objects.create(cv_view_enabled=False)
    seen = old.get_model("core", "CvView").objects.create(
        version="00000000-0000-4000-8000-000000000000"
    )
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    new = migrate(DOWNLOAD)

    settings_row = new.get_model("core", "SiteSettings").objects.get(id=row.id)
    assert settings_row.cv_view_enabled is False
    assert settings_row.cv_instant_download_enabled is True
    assert new.get_model("core", "CvView").objects.get(id=seen.id).kind == "view"


@pytest.mark.usefixtures("at_latest")
def test_the_download_migration_reverses():
    migrate(DOWNLOAD)
    migrate(CV)

    assert "cv_instant_download_enabled" not in columns("site_settings")
    assert "kind" not in columns("cv_views")
