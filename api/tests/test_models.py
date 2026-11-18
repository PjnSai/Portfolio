import pytest
from django.apps import apps
from django.conf import settings
from django.core.management import call_command
from django.db import connection, models

from core.models import Message

TABLES = {
    "site_settings",
    "sections",
    "section_items",
    "media",
    "cv_files",
    "messages",
    "revisions",
    "palettes",
    "audit_log",
    "admin_owner",
    "admin_credentials",
    "sessions",
    "rate_limit_blocks",
    "pending_actions",
}


# Content lives in section_items; these phase 1 tables were never used.
DROPPED = {
    "projects",
    "project_images",
    "project_fields",
    "tags",
    "project_tags",
    "experience",
    "education",
    "skill_groups",
    "skills",
    "links",
}


def core_models():
    return list(apps.get_app_config("core").get_models())


def test_tables_match_the_data_model():
    assert {model._meta.db_table for model in core_models()} == TABLES


@pytest.mark.django_db
def test_phase_one_typed_content_tables_are_gone():
    present = set(connection.introspection.table_names()) & DROPPED

    assert present == set()


def test_every_table_has_a_uuid_primary_key():
    for model in core_models():
        assert isinstance(model._meta.pk, models.UUIDField), model.__name__


@pytest.mark.django_db
def test_ids_are_random_not_sequential():
    first = Message.objects.create(name="A", email="a@example.com", body="A")
    second = Message.objects.create(name="B", email="b@example.com", body="B")

    assert first.id.version == 4
    assert first.id != second.id


@pytest.mark.django_db
def test_migrations_are_checked_in():
    call_command("makemigrations", "--check", "--dry-run")


def test_no_password_or_django_session_tables():
    for app in ("auth", "sessions", "admin", "contenttypes"):
        assert f"django.contrib.{app}" not in settings.INSTALLED_APPS
