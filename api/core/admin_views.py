import hashlib
import hmac
import re
import secrets

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token, rotate_token
from django.utils import timezone

from core import audit, notify, passkeys, ratelimit, responses, sessions, vital
from core.authz import Level, admin_route
from core.models import AdminCredential, AuditLog, Owner

POST = ("POST",)


def _credential(request):
    credential = request.json.get("credential")
    return credential if isinstance(credential, dict) else None


def _sign_in_failed(request, event):
    ratelimit.sign_in_failed(request)
    audit.record(event, actor="anonymous")
    return responses.sign_in_failed()


def _signed_in(request, response):
    """New CSRF secret on every privilege change, sent with the session cookie."""
    rotate_token(request)
    body = JsonResponse({"csrf_token": get_token(request)})
    body.cookies = response.cookies
    return body


@admin_route(Level.ACCESS)
def csrf(request):
    return JsonResponse({"csrf_token": get_token(request)})


# Sign-in


@admin_route(Level.ACCESS, methods=POST)
def login_options(request):
    # Only this client's own cool-down applies. The global one must not stop
    # the owner from starting a sign-in; it is enforced in login_verify.
    wait = ratelimit.client_cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    return JsonResponse(passkeys.authentication_options("login"))


@admin_route(Level.ACCESS, methods=POST)
def login_verify(request):
    wait = ratelimit.client_cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    credential = _credential(request)
    if credential is None:
        return responses.bad_request()
    # During the global cool-down a valid passkey still signs in. Every failure
    # gets the same 429 after the same work, whatever the reason it failed.
    throttled = ratelimit.global_cool_down()
    passkey = passkeys.authenticate(credential, "login")
    if passkey is None:
        failed = _sign_in_failed(request, "login_failed")
        return responses.too_many_requests(throttled) if throttled else failed

    ratelimit.sign_in_succeeded(request)
    response = JsonResponse({})
    with transaction.atomic():
        sessions.retire_presented(request)
        sessions.start(response)
        audit.record("login", passkey=str(passkey.id))
    return _signed_in(request, response)


# First passkey


def _sha256(value):
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()


def _secret_matches(supplied, expected_hash):
    if not expected_hash or not isinstance(supplied, str) or not supplied:
        return False
    return hmac.compare_digest(_sha256(supplied), expected_hash.lower())


def _recovery_key_matches(supplied, owner):
    if not owner.recovery_key_hash or not isinstance(supplied, str) or not supplied:
        return False
    return check_password(supplied, owner.recovery_key_hash)


def _bootstrap_open(owner, token):
    """Open only once: before the owner has ever enrolled, with the token."""
    if owner.bootstrapped_at is not None:
        return False
    if not _secret_matches(token, settings.BOOTSTRAP_TOKEN_SHA256):
        return False
    return not AdminCredential.objects.exists()


def _new_recovery_key(owner):
    """Store the hash of a fresh recovery key and return the key, shown once."""
    key = secrets.token_urlsafe(32)
    owner.recovery_key_hash = make_password(key)
    return key


def _name(request, default):
    name = request.json.get("name", default)
    if not isinstance(name, str) or not 0 < len(name) <= 100:
        return None
    return name


@admin_route(Level.ACCESS, methods=POST)
def bootstrap_options(request):
    wait = ratelimit.cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    if not _bootstrap_open(Owner.objects.get(), request.json.get("token")):
        return _sign_in_failed(request, "bootstrap_failed")
    return JsonResponse(passkeys.registration_options("bootstrap"))


@admin_route(Level.ACCESS, methods=POST)
def bootstrap_verify(request):
    wait = ratelimit.cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    credential = _credential(request)
    name = _name(request, "First passkey")
    if name is None:
        return responses.bad_request()
    passkey = None
    with transaction.atomic():
        # The row lock makes two bootstraps racing each other take turns, and
        # the second one finds it closed.
        owner = Owner.objects.select_for_update().get()
        if credential is not None and _bootstrap_open(owner, request.json.get("token")):
            passkey = passkeys.register(credential, name, "bootstrap")
        if passkey is not None:
            key = _new_recovery_key(owner)
            owner.bootstrapped_at = timezone.now()
            owner.save(update_fields=["bootstrapped_at", "recovery_key_hash"])
            audit.record("passkey_added", passkey=str(passkey.id), via="bootstrap")
    if passkey is None:
        return _sign_in_failed(request, "bootstrap_failed")
    return JsonResponse({"id": str(passkey.id), "recovery_key": key}, status=201)


# Recovery key: replaces every passkey when the owner has lost them all.


def _reset_access(keep=None):
    """Remove passkeys (all but keep), end every session, cancel pending actions."""
    removed = AdminCredential.objects.exclude(id=keep.id if keep else None)
    return {
        "passkeys": removed.delete()[0],
        "sessions": sessions.revoke_all(),
        "pending_actions": vital.cancel_all(),
    }


@admin_route(Level.ACCESS, methods=POST)
def recovery_options(request):
    wait = ratelimit.cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    owner = Owner.objects.get()
    if not _recovery_key_matches(request.json.get("key"), owner):
        return _sign_in_failed(request, "recovery_failed")
    return JsonResponse(passkeys.registration_options("recovery"))


@admin_route(Level.ACCESS, methods=POST)
def recovery_verify(request):
    wait = ratelimit.cool_down(request)
    if wait:
        return responses.too_many_requests(wait)
    credential = _credential(request)
    name = _name(request, "Recovery passkey")
    if name is None:
        return responses.bad_request()
    passkey = None
    try:
        with transaction.atomic():
            owner = Owner.objects.select_for_update().get()
            supplied = request.json.get("key")
            if credential is not None and _recovery_key_matches(supplied, owner):
                passkey = passkeys.register(credential, name, "recovery")
            if passkey is not None:
                counts = _reset_access(keep=passkey)
                key = _new_recovery_key(owner)
                owner.save(update_fields=["recovery_key_hash"])
                audit.record("recovery_used", passkey=str(passkey.id), **counts)
                # Recovery must never happen without the owner hearing of it.
                notify.send_required("recovery_used", name=passkey.name)
    except notify.Undelivered:
        audit.record("recovery_refused", actor="anonymous", reason="notice not sent")
        return responses.unavailable()
    if passkey is None:
        return _sign_in_failed(request, "recovery_failed")
    return JsonResponse({"id": str(passkey.id), "recovery_key": key}, status=201)


# Session


@admin_route(Level.SESSION)
def session(request):
    current = request.admin_session
    return JsonResponse(
        {
            "csrf_token": get_token(request),
            "elevated": sessions.is_elevated(current),
            "pending_actions": vital.pending().count(),
        }
    )


@admin_route(Level.SESSION, methods=POST)
def logout(request):
    with transaction.atomic():
        sessions.revoke(request.admin_session)
        audit.record("logout")
    response = JsonResponse({})
    sessions.clear_cookie(response)
    return response


@admin_route(Level.ELEVATED, methods=POST)
def revoke_all(request):
    with transaction.atomic():
        count = sessions.revoke_all()
        audit.record("sessions_revoked", count=count)
    notify.send_if_possible("sessions_revoked", count=count)
    response = JsonResponse({})
    sessions.clear_cookie(response)
    return response


@admin_route(Level.ELEVATED, methods=POST)
def access_revoke_all(request):
    # Runs at once, with no delay: it only ever takes access away.
    with transaction.atomic():
        counts = _reset_access()
        audit.record("access_revoked", **counts)
    notify.send_if_possible("access_revoked", **counts)
    response = JsonResponse({})
    sessions.clear_cookie(response)
    return response


# Passkeys


@admin_route(Level.SESSION)
def passkey_list(request):
    return JsonResponse(
        {
            "passkeys": [
                {
                    "id": str(passkey.id),
                    "name": passkey.name,
                    "created_at": passkey.created_at.isoformat(),
                    "last_used_at": passkey.last_used_at.isoformat()
                    if passkey.last_used_at
                    else None,
                }
                for passkey in AdminCredential.objects.order_by("created_at")
            ]
        }
    )


# Passkey confirmation before a vital action


@admin_route(Level.SESSION, methods=POST)
def elevate_options(request):
    scope = str(request.admin_session.id)
    return JsonResponse(passkeys.authentication_options("elevate", scope))


@admin_route(Level.SESSION, methods=POST)
def elevate_verify(request):
    credential = _credential(request)
    if credential is None:
        return responses.bad_request()
    current = request.admin_session
    passkey = passkeys.authenticate(credential, "elevate", str(current.id))
    if passkey is None:
        audit.record("elevation_failed")
        return responses.forbidden()
    response = JsonResponse({})
    with transaction.atomic():
        sessions.rotate(
            response, current, elevated_until=timezone.now() + sessions.ELEVATION
        )
        audit.record("elevated", passkey=str(passkey.id))
    return _signed_in(request, response)


# Audit log

AUDIT_PARAMS = {"event", "before", "limit", "flagged"}
AUDIT_PAGE = 50
AUDIT_MAX_PAGE = 100
DIGITS = re.compile(r"[0-9]{1,18}")


def _number(params, name, default, highest):
    """A plain positive integer from the query string, or None if it is not one."""
    if name not in params:
        return default
    raw = params.get(name)
    if not DIGITS.fullmatch(raw) or not 1 <= int(raw) <= highest:
        return None
    return int(raw)


@admin_route(Level.SESSION)
def audit_list(request):
    params = request.GET
    repeated = any(len(values) != 1 for _, values in params.lists())
    if repeated or not AUDIT_PARAMS.issuperset(params):
        return responses.bad_request()
    limit = _number(params, "limit", AUDIT_PAGE, AUDIT_MAX_PAGE)
    before = _number(params, "before", 0, 10**18)
    if limit is None or before is None:
        return responses.bad_request()
    entries = AuditLog.objects.order_by("-seq")
    if before:
        entries = entries.filter(seq__lt=before)
    if "event" in params:
        event = params.get("event")
        if not 0 < len(event) <= 60 or not event.isprintable():
            return responses.bad_request()
        entries = entries.filter(event=event)
    if "flagged" in params:
        if params.get("flagged") != "1":
            return responses.bad_request()
        entries = entries.filter(event__in=audit.FLAGGED)
    page = list(entries[: limit + 1])
    more = len(page) > limit
    page = page[:limit]
    return JsonResponse(
        {
            "entries": [
                {
                    "seq": entry.seq,
                    "at": entry.created_at.isoformat(),
                    "event": entry.event,
                    "actor": entry.actor,
                    "detail": entry.detail,
                    "hash": entry.hash,
                    "flagged": entry.event in audit.FLAGGED,
                }
                for entry in page
            ],
            "next_before": page[-1].seq if more else None,
        }
    )


@admin_route(Level.SESSION)
def audit_verify(request):
    result = audit.verify_chain()
    return JsonResponse(
        {
            "ok": result.ok,
            "entries": result.entries,
            "first_bad_seq": result.first_bad_seq,
        }
    )


# Vital actions

REFUSALS = {
    vital.Outcome.MISSING: responses.not_found,
    vital.Outcome.CONFLICT: responses.conflict,
    vital.Outcome.INVALID: responses.bad_request,
}


@admin_route(Level.SESSION)
def vital_list(request):
    actions = vital.pending().order_by("requested_at")
    return JsonResponse({"actions": [vital.describe(action) for action in actions]})


@admin_route(Level.ELEVATED, methods=POST)
def vital_request(request):
    # Only kind and payload are read. The delay is fixed on the server.
    kind = request.json.get("kind")
    payload = vital.clean(kind, request.json.get("payload"))
    if payload is None:
        return responses.bad_request()
    try:
        action = vital.request(kind, payload)
    except notify.Undelivered:
        audit.record("vital_action_refused", kind=kind, reason="notice not sent")
        return responses.unavailable()
    return JsonResponse(vital.describe(action), status=201)


@admin_route(Level.SESSION, methods=POST)
def vital_cancel(request, action_id):
    action, outcome = vital.cancel(action_id)
    if outcome is not vital.Outcome.OK:
        return REFUSALS[outcome]()
    return JsonResponse(vital.describe(action))


@admin_route(Level.ELEVATED, methods=POST)
def vital_passkey_options(request, action_id):
    options, outcome = vital.passkey_options(action_id)
    if outcome is not vital.Outcome.OK:
        return REFUSALS[outcome]()
    return JsonResponse(options)


@admin_route(Level.ELEVATED, methods=POST)
def vital_execute(request, action_id):
    try:
        action, outcome = vital.run(action_id, _credential(request))
    except notify.Undelivered:
        audit.record("vital_action_refused", reason="notice not sent")
        return responses.unavailable()
    if outcome is not vital.Outcome.OK:
        return REFUSALS[outcome]()
    return JsonResponse(vital.describe(action))
