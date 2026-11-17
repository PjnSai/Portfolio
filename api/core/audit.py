"""Append-only audit log with an HMAC hash chain.

Each entry's hash covers its own fields and the hash of the entry before it, keyed
with AUDIT_CHAIN_KEY. Changing, removing or reordering an entry breaks the chain,
and someone with database access but not the key cannot recompute it.

Limit: removing the newest entries leaves a shorter chain that still verifies.
Catching that needs the latest seq and hash to be kept somewhere else.
"""

import hashlib
import hmac
import json
from dataclasses import dataclass

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.db import IntegrityError, transaction
from django.utils import timezone

from core.models import AuditLog

GENESIS = "0" * 64
ATTEMPTS = 5


@dataclass(frozen=True)
class Result:
    ok: bool
    entries: int
    first_bad_seq: int | None = None


def entry_hash(seq, created_at, event, actor, detail, prev_hash):
    message = json.dumps(
        [seq, created_at.isoformat(), event, actor, detail, prev_hash],
        sort_keys=True,
        separators=(",", ":"),
    )
    key = settings.AUDIT_CHAIN_KEY.encode()
    return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()


def record(event, actor="admin", **detail):
    """Append one entry and return it. Detail must never hold secrets or IPs."""
    detail = json.loads(json.dumps(detail, cls=DjangoJSONEncoder))
    for attempt in range(ATTEMPTS):
        try:
            with transaction.atomic():
                return _append(event, actor, detail)
        except IntegrityError:
            # Another writer took this place in the chain. Read the tail again.
            if attempt == ATTEMPTS - 1:
                raise


def _append(event, actor, detail):
    last = AuditLog.objects.order_by("-seq").first()
    seq = last.seq + 1 if last else 1
    prev_hash = last.hash if last else GENESIS
    created_at = timezone.now()
    return AuditLog.objects.create(
        seq=seq,
        created_at=created_at,
        event=event,
        actor=actor,
        detail=detail,
        prev_hash=prev_hash,
        hash=entry_hash(seq, created_at, event, actor, detail, prev_hash),
    )


def verify_chain():
    """Walk the whole log and report the first entry that does not fit."""
    expected_seq, prev_hash = 1, GENESIS
    for entry in AuditLog.objects.order_by("seq").iterator():
        expected = entry_hash(
            entry.seq,
            entry.created_at,
            entry.event,
            entry.actor,
            entry.detail,
            entry.prev_hash,
        )
        if (
            entry.seq != expected_seq
            or entry.prev_hash != prev_hash
            or not hmac.compare_digest(entry.hash, expected)
        ):
            return Result(False, expected_seq - 1, entry.seq)
        expected_seq, prev_hash = entry.seq + 1, entry.hash
    return Result(True, expected_seq - 1)
