from django.db import migrations, models
from django.db.models import F


def backfill(apps, schema_editor):
    # Spam stored before this column existed is taken to have been spam from
    # the start, which is what its expiry already assumed.
    message = apps.get_model("core", "ContactMessage")
    message.objects.filter(status="spam").update(spam_at=F("created_at"))


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0015_drop_old_messages"),
    ]

    operations = [
        migrations.AddField(
            model_name="contactmessage",
            name="spam_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
