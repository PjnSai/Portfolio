"""Vital actions: adding or revoking a passkey, permanent deletion (content,
messages and CV versions), deleting everything about one email (core.erase)
and changing the CV switches (core.cv).

Each one is requested with a fresh passkey confirmation, waits 24 hours, and is
run with another fresh confirmation. The owner is told when it is requested and
can cancel it with an ordinary session at any point before it runs. The delay
and the kinds are fixed here; nothing the client sends can change them.
"""

import enum
import re
from datetime import timedelta

from django.db import transaction
from django.urls import reverse
from django.utils import timezone

from core import audit, blocklist, content, cv, erase, notify, passkeys, retention
from core.models import (
    AdminCredential,
    ContactMessage,
    CvVersion,
    PendingAction,
    Section,
    SectionItem,
)

DELAY = timedelta(hours=24)
# How long a matured action stays runnable before it expires unused.
WINDOW = timedelta(days=7)

ADD_PASSKEY = "add_passkey"
REVOKE_PASSKEY = "revoke_passkey"
PERMANENT_DELETE = "permanent_delete"
ERASE_SENDER = erase.KIND
CV_SWITCHES = cv.SWITCHES

# Allow-list. Auth and audit tables can never be named here.
DELETABLE = {
    "message": ContactMessage,
    "section": Section,
    "item": SectionItem,
    "cv_version": CvVersion,
}
# Content that must be in the trash first, and still be there when it runs.
TRASH_FIRST = {"section", "item"}

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
Status = PendingAction.Status


class Outcome(enum.Enum):
    OK = "ok"
    MISSING = "missing"
    CONFLICT = "conflict"
    INVALID = "invalid"


def clean(kind, payload):
    """The payload reduced to its known fields, or None if it is not valid."""
    if not isinstance(kind, str) or not isinstance(payload, dict):
        return None
    if kind == ADD_PASSKEY:
        name = payload.get("name")
        if not isinstance(name, str):
            return None
        name = name.strip()
        if not 0 < len(name) <= 100 or not name.isprintable():
            return None
        return {"name": name}
    if kind == REVOKE_PASSKEY:
        target = payload.get("id")
        if not isinstance(target, str) or not UUID.fullmatch(target):
            return None
        if not AdminCredential.objects.filter(id=target).exists():
            return None
        return {"id": target}
    if kind == PERMANENT_DELETE:
        entity, target = payload.get("entity"), payload.get("id")
        if not isinstance(entity, str) or not isinstance(target, str):
            return None
        model = DELETABLE.get(entity)
        if model is None or not UUID.fullmatch(target):
            return None
        rows = model.objects.filter(id=target)
        if entity in TRASH_FIRST:
            rows = rows.exclude(trashed_at=None)
        if entity == "cv_version":
            rows = rows.filter(is_live=False)
        if not rows.exists():
            return None
        return {"entity": entity, "id": target}
    if kind == ERASE_SENDER:
        return erase.clean(payload)
    if kind == CV_SWITCHES:
        return cv.clean_switches(payload)
    return None


def cancel_path(action):
    return reverse("vital-action-cancel", args=[action.id])


def state(action):
    if action.status == Status.EXECUTED:
        return "done"
    if action.status != Status.PENDING:
        return str(action.status)
    now = timezone.now()
    if now >= action.expires_at:
        return "expired"
    return "ready" if now >= action.execute_after else "waiting"


def describe(action):
    return {
        "id": str(action.id),
        "kind": action.kind,
        "target": _shown(action),
        "state": state(action),
        "requested_at": action.requested_at.isoformat(),
        "execute_after": action.execute_after.isoformat(),
        "expires_at": action.expires_at.isoformat(),
        "cancel_path": cancel_path(action),
    }


def _shown(action):
    if action.kind == ERASE_SENDER:
        return erase.shown(action.payload)
    return action.payload


def pending():
    """Actions still waiting or ready to run."""
    return PendingAction.objects.filter(
        status=Status.PENDING, expires_at__gt=timezone.now()
    )


def _detail(action):
    return {"action": str(action.id), "kind": action.kind, "target": action.payload}


def request(kind, payload):
    """Start the wait. Raises notify.Undelivered, leaving nothing behind, if the
    owner cannot be told."""
    now = timezone.now()
    with transaction.atomic():
        action = PendingAction.objects.create(
            kind=kind,
            payload=payload,
            requested_at=now,
            execute_after=now + DELAY,
            expires_at=now + DELAY + WINDOW,
        )
        audit.record("vital_action_requested", **_detail(action))
        notify.send_required(
            "vital_action_requested",
            id=str(action.id),
            kind=kind,
            execute_after=action.execute_after.isoformat(),
            cancel_path=cancel_path(action),
        )
    return action


def _resolve(action, status):
    action.status = status
    action.resolved_at = timezone.now()
    action.save(update_fields=["status", "resolved_at"])


def _locked(action_id):
    """The action, locked until the transaction ends so it cannot run twice."""
    return PendingAction.objects.select_for_update().filter(id=action_id).first()


def _claim(action_id):
    """Lock the action and say whether it may run now."""
    action = _locked(action_id)
    if action is None:
        return None, Outcome.MISSING
    if action.status != Status.PENDING:
        return action, Outcome.CONFLICT
    now = timezone.now()
    if now >= action.expires_at:
        _resolve(action, Status.EXPIRED)
        audit.record("vital_action_expired", actor="system", **_detail(action))
        return action, Outcome.CONFLICT
    if now < action.execute_after:
        return action, Outcome.CONFLICT
    return action, Outcome.OK


def cancel(action_id):
    with transaction.atomic():
        action = _locked(action_id)
        if action is None:
            return None, Outcome.MISSING
        if action.status != Status.PENDING:
            return action, Outcome.CONFLICT
        _resolve(action, Status.CANCELLED)
        audit.record("vital_action_cancelled", **_detail(action))
    return action, Outcome.OK


def passkey_options(action_id):
    """Registration options for a matured add-passkey action."""
    with transaction.atomic():
        action, outcome = _claim(action_id)
        if outcome is Outcome.OK and action.kind != ADD_PASSKEY:
            outcome = Outcome.CONFLICT
    if outcome is not Outcome.OK:
        return None, outcome
    return passkeys.registration_options(ADD_PASSKEY, str(action.id)), outcome


def run(action_id, credential=None):
    """Run a matured action once. Raises notify.Undelivered, undoing the run, if
    a new passkey cannot be reported to the owner."""
    with transaction.atomic():
        action, outcome = _claim(action_id)
        if outcome is not Outcome.OK:
            return action, outcome
        result = None
        if action.kind == ADD_PASSKEY:
            if not _add_passkey(action, credential):
                return action, Outcome.INVALID
        elif action.kind == REVOKE_PASSKEY:
            if not _revoke_passkey(action):
                return action, Outcome.CONFLICT
        elif action.kind == ERASE_SENDER:
            try:
                result = erase.run(action.payload)
            except (retention.Busy, blocklist.Full):
                return action, Outcome.CONFLICT
            if result is None:
                return action, Outcome.CONFLICT
        elif action.kind == CV_SWITCHES:
            cv.set_switches(action.payload)
        elif action.kind == PERMANENT_DELETE:
            entity = action.payload.get("entity")
            model = DELETABLE.get(entity)
            if model is None:
                return action, Outcome.CONFLICT
            if entity in TRASH_FIRST:
                if not content.delete_for_good(entity, action.payload["id"]):
                    return action, Outcome.CONFLICT
            elif entity == "cv_version":
                # Its file too, and never the live one.
                if not cv.delete_version(action.payload["id"]):
                    return action, Outcome.CONFLICT
            else:
                model.objects.filter(id=action.payload["id"]).delete()
        else:
            return action, Outcome.CONFLICT
        _resolve(action, Status.EXECUTED)
        if result is None:
            audit.record("vital_action_executed", **_detail(action))
        else:
            audit.record("vital_action_executed", **_detail(action), result=result)
    return action, Outcome.OK


def _add_passkey(action, credential):
    if not isinstance(credential, dict):
        return False
    passkey = passkeys.register(
        credential, action.payload["name"], ADD_PASSKEY, str(action.id)
    )
    if passkey is None:
        return False
    audit.record("passkey_added", passkey=str(passkey.id), via="vital_action")
    notify.send_required("passkey_added", name=passkey.name)
    return True


def _revoke_passkey(action):
    passkey = AdminCredential.objects.filter(id=action.payload.get("id")).first()
    if passkey is None:
        return False
    passkey.delete()
    audit.record("passkey_revoked", passkey=str(action.payload["id"]))
    notify.send_required("passkey_revoked", name=passkey.name)
    return True


def cancel_all():
    """Cancel everything still pending. Used when access is reset."""
    return PendingAction.objects.filter(status=Status.PENDING).update(
        status=Status.CANCELLED, resolved_at=timezone.now()
    )
