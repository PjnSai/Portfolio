"""manage.py run_retention: the daily job that removes contact messages whose
retention period has ended (SPEC 5.8a (e), 6.2)."""

import json
from datetime import timedelta
from io import StringIO

import psycopg
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import OperationalError, connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import audit, retention
from core.models import AuditLog, ContactMessage, ContactNote
from tests.conftest import new_message

pytestmark = pytest.mark.django_db

DAY = timedelta(days=1)
NAME = "Ottoline Brackenbury"
EMAIL = "ottoline.brackenbury@retention-example.org"
BODY = "A private paragraph about the lighthouse restoration."
# The job also removes expired blocklist entries in a statement of its own.
MESSAGE_DELETE = 'DELETE FROM "contact_messages"'


def message(expired=True, **fields):
    now = timezone.now()
    values = {
        "name": NAME,
        "email": EMAIL,
        "body": BODY,
        "created_at": now - 400 * DAY,
        "expires_at": now - DAY if expired else now + DAY,
    }
    values.update(fields)
    return new_message(**values)


def run(*args):
    out = StringIO()
    call_command("run_retention", *args, stdout=out)
    return out.getvalue()


def left():
    return set(ContactMessage.objects.values_list("id", flat=True))


def runs():
    return list(AuditLog.objects.filter(event="retention_run").order_by("seq"))


# What is removed and what is kept


def test_an_expired_message_is_deleted():
    gone = message()

    run()

    assert gone.id not in left()


def test_a_kept_message_is_exempt():
    kept = message(kept=True)

    run()

    assert kept.id in left()


def test_a_message_with_a_note_is_exempt():
    noted = message()
    ContactNote.objects.create(message=noted, text="Follow up in spring.")

    run()

    assert noted.id in left()
    assert ContactNote.objects.filter(message=noted).exists()


def test_a_message_not_yet_expired_is_left():
    fresh = message(expired=False)

    run()

    assert fresh.id in left()


def test_each_exemption_on_its_own_and_the_one_that_goes():
    gone = message()
    kept = message(kept=True)
    noted = message()
    ContactNote.objects.create(message=noted, text="Seen.")
    fresh = message(expired=False)

    output = run()

    assert left() == {kept.id, noted.id, fresh.id}
    assert gone.id not in left()
    assert "Deleted 1 messages; 2 past their date" in output


def test_spam_marked_recently_is_kept_although_it_arrived_long_ago():
    now = timezone.now()
    recent = ContactMessage(
        name=NAME,
        email=EMAIL,
        body=BODY,
        status="spam",
        created_at=now - 300 * DAY,
        spam_at=now - 5 * DAY,
    )
    retention.apply(recent)
    recent.save(force_insert=True)
    old = ContactMessage(
        name=NAME,
        email=EMAIL,
        body=BODY,
        status="spam",
        created_at=now - 300 * DAY,
        spam_at=now - 31 * DAY,
    )
    retention.apply(old)
    old.save(force_insert=True)

    run()

    assert left() == {recent.id}


def test_a_note_added_between_runs_protects_the_message():
    target = message()
    assert "Would delete 1 messages" in run("--dry-run")

    ContactNote.objects.create(message=target, text="Wait, keep this.")
    run()

    assert target.id in left()


def test_keeping_a_message_between_runs_protects_it():
    target = message()
    run("--dry-run")

    ContactMessage.objects.filter(id=target.id).update(kept=True)
    run()

    assert target.id in left()


def test_notes_go_with_nothing_else():
    keep = message(expired=False)
    ContactNote.objects.create(message=keep, text="Note.")
    message()

    run()

    assert ContactNote.objects.count() == 1


# Dry run, batches and one statement


def test_a_dry_run_deletes_nothing_and_counts():
    rows = {message().id for _ in range(3)}
    message(kept=True)

    output = run("--dry-run")

    assert rows <= left()
    assert "Would delete 3 messages; 1 past their date" in output
    (entry,) = runs()
    assert entry.detail == {
        "deleted": 3,
        "exempt": 1,
        "batches": 0,
        "blocklist_deleted": 0,
        "dry_run": True,
    }


def test_batches_remove_everything_due():
    for _ in range(7):
        message()
    message(kept=True)

    run("--batch-size", "3")

    assert ContactMessage.objects.count() == 1
    (entry,) = runs()
    assert entry.detail == {
        "deleted": 7,
        "exempt": 1,
        "batches": 3,
        "blocklist_deleted": 0,
        "dry_run": False,
    }


def test_each_batch_is_one_delete_with_no_select_of_ids_before_it():
    for _ in range(5):
        message()

    with CaptureQueriesContext(connection) as queries:
        run("--batch-size", "2")

    sql = [q["sql"].strip() for q in queries.captured_queries]
    deletes = [s for s in sql if s.startswith(MESSAGE_DELETE)]
    assert len(deletes) == 3
    for statement in deletes:
        assert "NOT" in statement and "kept" in statement
        assert "contact_notes" in statement
        assert "expires_at" in statement
    touching = [s for s in sql if "contact_messages" in s]
    assert all(s.startswith(("DELETE", "SELECT COUNT(*)")) for s in touching)


def test_a_batch_never_grows_past_its_size_whatever_the_plan():
    # Statistics from an empty table lead Postgres to a plan that runs an
    # id IN (subquery) again for each row deleted, so a batch of 3 removed 4.
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE contact_messages")
        cursor.execute("ANALYZE contact_notes")
    for _ in range(7):
        message()

    with CaptureQueriesContext(connection) as queries:
        run("--batch-size", "3")

    sql = [q["sql"] for q in queries.captured_queries]
    deletes = [s for s in sql if s.startswith(MESSAGE_DELETE)]
    assert len(deletes) == 3
    (entry,) = runs()
    assert entry.detail["batches"] == 3
    assert entry.detail["deleted"] == 7


@pytest.mark.parametrize("size", ["0", "-1", "x", "10001", "2.5"])
def test_a_bad_batch_size_is_refused(size):
    message()

    with pytest.raises(CommandError):
        run("--batch-size", size)

    assert ContactMessage.objects.count() == 1


def test_nothing_due_still_records_the_run():
    message(expired=False)

    run()

    (entry,) = runs()
    assert entry.detail == {
        "deleted": 0,
        "exempt": 0,
        "batches": 1,
        "blocklist_deleted": 0,
        "dry_run": False,
    }


# Audit: counts only


def test_one_audit_entry_per_run_with_counts_only():
    gone = message()
    kept = message(kept=True)
    ContactNote.objects.create(message=message(), text="Private note words.")

    run()
    run("--dry-run")

    first, second = runs()
    for entry in (first, second):
        assert set(entry.detail) == {
            "deleted",
            "exempt",
            "batches",
            "blocklist_deleted",
            "dry_run",
        }
        assert all(
            isinstance(v, int) for k, v in entry.detail.items() if k != "dry_run"
        )
        assert isinstance(entry.detail["dry_run"], bool)
    everything = json.dumps(list(AuditLog.objects.values()), default=str)
    for private in (
        NAME,
        EMAIL,
        BODY,
        "Private note words",
        str(gone.id),
        str(kept.id),
    ):
        assert private not in everything
    assert audit.verify_chain().ok


# Overlapping runs


@pytest.fixture
def other_session():
    """A second database connection, as a second run of the job would have."""
    db = connection.settings_dict
    other = psycopg.connect(
        dbname=db["NAME"],
        user=db["USER"],
        password=db["PASSWORD"],
        host=db["HOST"],
        port=db["PORT"],
        autocommit=True,
    )
    yield other
    other.close()


def test_a_second_run_while_one_holds_the_lock_does_nothing(other_session):
    target = message()
    other_session.execute("SELECT pg_advisory_lock(%s)", [retention.LOCK_KEY])

    with pytest.raises(CommandError, match="in progress"):
        run()

    assert target.id in left()
    assert runs() == []

    other_session.execute("SELECT pg_advisory_unlock(%s)", [retention.LOCK_KEY])
    run()
    assert target.id not in left()


def test_the_lock_is_held_for_the_whole_run(other_session, monkeypatch):
    message()
    seen = []
    record = audit.record

    def check_then_record(*args, **kwargs):
        got = other_session.execute(
            "SELECT pg_try_advisory_lock(%s)", [retention.LOCK_KEY]
        ).fetchone()[0]
        seen.append(got)
        return record(*args, **kwargs)

    monkeypatch.setattr(audit, "record", check_then_record)

    run()

    assert seen == [False]


INSERT_COMMITTED = """
    INSERT INTO contact_messages (id, name, email, body, reason, spam_score,
        status, created_at, kept, expires_at, ip_hash)
    VALUES (gen_random_uuid(), 'Other', 'other@example.com', 'Held by another.',
        '', 0, 'read', now() - interval '400 days', false,
        now() - interval '1 day', '')
    RETURNING id
"""


@pytest.fixture
def held_elsewhere(other_session):
    """An expired message another transaction holds, as adding a note does."""
    held = other_session.execute(INSERT_COMMITTED).fetchone()[0]
    try:
        with other_session.transaction():
            other_session.execute(
                "SELECT id FROM contact_messages WHERE id = %s FOR UPDATE", [held]
            )
            yield held
    finally:
        other_session.execute("DELETE FROM contact_messages WHERE id = %s", [held])


def test_a_message_another_transaction_holds_is_skipped_not_waited_on(
    held_elsewhere,
):
    gone = message()
    with connection.cursor() as cursor:
        cursor.execute("SET lock_timeout = '3s'")
    try:
        run()
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET lock_timeout")

    assert held_elsewhere in left()
    assert gone.id not in left()
    (entry,) = runs()
    assert entry.detail["deleted"] == 1


# Failing closed


def test_the_database_being_down_fails_and_deletes_nothing(monkeypatch):
    target = message()

    def down():
        raise OperationalError("database down")

    monkeypatch.setattr(retention, "_lock", down)

    with pytest.raises(CommandError, match="Nothing was deleted"):
        run()

    monkeypatch.undo()
    assert target.id in left()
    assert runs() == []


def test_a_failure_part_way_deletes_nothing(monkeypatch):
    rows = {message().id for _ in range(4)}

    def broken(*args, **kwargs):
        raise OperationalError("audit write failed")

    monkeypatch.setattr(audit, "record", broken)

    with pytest.raises(CommandError, match="Nothing was deleted"):
        run("--batch-size", "2")

    assert rows <= left()


def test_a_note_that_slips_past_the_rules_makes_the_run_fail_not_lose_it(
    monkeypatch, caplog
):
    # Were the notes rule ever missing, the notes foreign key would still refuse
    # the delete, and the whole run would be undone.
    target = message()
    ContactNote.objects.create(message=target, text="Keep me.")
    monkeypatch.setattr(
        retention, "rules", lambda now: (Q(expires_at__lte=now), Q(kept=False))
    )
    # The test runs inside a transaction that never commits, so ask Postgres to
    # check the deferred key now rather than at a commit that never comes.
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    with pytest.raises(CommandError, match="Nothing was deleted"):
        run()

    assert "outcome=database_error IntegrityError" in caplog.text
    assert target.id in left()
    assert runs() == []
