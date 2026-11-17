import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


def create_owner(apps, schema_editor):
    apps.get_model("core", "Owner").objects.create()


def end_sessions(apps, schema_editor):
    # Sessions from before the owner row existed cannot be tied to it.
    apps.get_model("core", "Session").objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [("core", "0002_audit_log_guard")]

    operations = [
        migrations.CreateModel(
            name="Owner",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "singleton",
                    models.BooleanField(default=True, editable=False, unique=True),
                ),
                (
                    "created_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("bootstrapped_at", models.DateTimeField(blank=True, null=True)),
                (
                    "recovery_key_hash",
                    models.CharField(blank=True, default="", max_length=64),
                ),
            ],
            options={
                "db_table": "admin_owner",
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(singleton=True),
                        name="admin_owner_single_row",
                    )
                ],
            },
        ),
        migrations.RunPython(create_owner, migrations.RunPython.noop),
        migrations.RunPython(end_sessions, migrations.RunPython.noop),
        migrations.AddField(
            model_name="session",
            name="owner",
            field=models.ForeignKey(
                default=None,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="core.owner",
            ),
            preserve_default=False,
        ),
    ]
