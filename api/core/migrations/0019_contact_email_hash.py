import hashlib
import hmac

from django.conf import settings
from django.db import migrations, models


def email_hash(email):
    # The same as core.contact.email_hash, copied so this migration does not
    # change if that module does.
    key = settings.SECRET_KEY.encode()
    text = f"contact-email:{email.strip().lower()}"
    return hmac.new(key, text.encode(), hashlib.sha256).hexdigest()


def fill(apps, schema_editor):
    ContactMessage = apps.get_model("core", "ContactMessage")
    for message in ContactMessage.objects.filter(email_hash="").iterator():
        ContactMessage.objects.filter(id=message.id).update(
            email_hash=email_hash(message.email)
        )


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0018_blocklist"),
    ]

    operations = [
        migrations.AddField(
            model_name="contactmessage",
            name="email_hash",
            field=models.CharField(
                blank=True, db_index=True, default="", db_default="", max_length=64
            ),
        ),
        migrations.RunPython(fill, migrations.RunPython.noop),
    ]
