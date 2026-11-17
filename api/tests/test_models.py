import pytest
from django.apps import apps
from django.conf import settings
from django.core.management import call_command
from django.db import models

from core.models import Project

TABLES = {
    "site_settings",
    "sections",
    "section_items",
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
    "media",
    "cv_files",
    "messages",
    "revisions",
    "audit_log",
    "admin_owner",
    "admin_credentials",
    "sessions",
    "rate_limit_blocks",
    "pending_actions",
}


def core_models():
    return list(apps.get_app_config("core").get_models())


def test_tables_match_the_data_model():
    assert {model._meta.db_table for model in core_models()} == TABLES


def test_every_table_has_a_uuid_primary_key():
    for model in core_models():
        assert isinstance(model._meta.pk, models.UUIDField), model.__name__


@pytest.mark.django_db
def test_ids_are_random_not_sequential():
    first = Project.objects.create(slug="a", title="A")
    second = Project.objects.create(slug="b", title="B")

    assert first.id.version == 4
    assert first.id != second.id


@pytest.mark.django_db
def test_migrations_are_checked_in():
    call_command("makemigrations", "--check", "--dry-run")


def test_no_password_or_django_session_tables():
    for app in ("auth", "sessions", "admin", "contenttypes"):
        assert f"django.contrib.{app}" not in settings.INSTALLED_APPS
