import hashlib
import json

import pytest
from django.db import Error, connection, transaction

from core import audit
from core.models import AuditLog

pytestmark = pytest.mark.django_db


@pytest.fixture
def chain():
    return [audit.record("login", attempt=n) for n in range(4)]


@pytest.fixture
def unprotected():
    """Simulates someone with owner rights on the table switching the guard off."""
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE audit_log DISABLE TRIGGER USER")


def test_entries_are_chained(chain):
    assert [entry.seq for entry in chain] == [1, 2, 3, 4]
    assert chain[0].prev_hash == audit.GENESIS
    for previous, entry in zip(chain, chain[1:], strict=False):
        assert entry.prev_hash == previous.hash

    result = audit.verify_chain()
    assert result.ok is True
    assert result.entries == 4
    assert result.first_bad_seq is None


def test_empty_log_verifies():
    assert audit.verify_chain().ok is True


def test_rows_cannot_be_updated(chain):
    with pytest.raises(Error), transaction.atomic():
        AuditLog.objects.filter(seq=2).update(event="logout")


def test_rows_cannot_be_deleted(chain):
    with pytest.raises(Error), transaction.atomic():
        AuditLog.objects.filter(seq=2).delete()


def test_table_cannot_be_truncated(chain):
    with pytest.raises(Error), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("TRUNCATE audit_log")


def test_edited_entry_is_detected(chain, unprotected):
    AuditLog.objects.filter(seq=2).update(detail={"attempt": 99})

    result = audit.verify_chain()
    assert result.ok is False
    assert result.first_bad_seq == 2


def test_removed_entry_is_detected(chain, unprotected):
    AuditLog.objects.filter(seq=2).delete()

    result = audit.verify_chain()
    assert result.ok is False
    assert result.first_bad_seq == 3


def test_entry_rehashed_without_the_key_is_detected(chain, unprotected):
    entry = AuditLog.objects.get(seq=4)
    forged = {"attempt": 99}
    plain = json.dumps([entry.seq, entry.event, forged, entry.prev_hash]).encode()
    AuditLog.objects.filter(seq=4).update(
        detail=forged, hash=hashlib.sha256(plain).hexdigest()
    )

    result = audit.verify_chain()
    assert result.ok is False
    assert result.first_bad_seq == 4


def test_reordered_entries_are_detected(chain, unprotected):
    AuditLog.objects.filter(seq=2).update(seq=20)
    AuditLog.objects.filter(seq=3).update(seq=2)
    AuditLog.objects.filter(seq=20).update(seq=3)

    assert audit.verify_chain().ok is False


def test_chain_cannot_fork(chain):
    with pytest.raises(Error), transaction.atomic():
        AuditLog.objects.create(
            seq=99,
            created_at=chain[0].created_at,
            event="login",
            actor="admin",
            detail={},
            prev_hash=chain[0].hash,
            hash="f" * 64,
        )
