from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0014_contact_reason_score_retention"),
    ]

    operations = [
        migrations.DeleteModel(
            name="Message",
        ),
    ]
