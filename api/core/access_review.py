"""The access review (SPEC 5.11, 10.6): every principal that can touch the
system, what it can and cannot do, its credential, expiry and last use.

The two database roles are described from the database's own answer, not from
a list kept here: has_table_privilege and its kin are asked for every table,
so the page shows the grants actually in force. The pipeline, the Cloudflare
token and where the recovery key is kept cannot be seen from the API, so they
have a fixed description that says so (docs/ACCESS.md has the rest).

Nothing here returns a secret, token, key, session id or hash: only whether a
setting is set, and times.
"""

from django.apps import apps
from django.conf import settings
from django.db.models import BooleanField, CharField, Func, Value
from django.utils import timezone

from core import sessions
from core.models import AdminCredential, AuditLog, Owner, Session, SiteSettings

APP_ROLE = "app_rw"
MIGRATION_ROLE = "migrator"
SCHEMA = "public"
NOT_CHECKED = "Not checked by the app."

# Table privileges, in the order they are shown, with the words used for them.
PRIVILEGES = {
    "SELECT": "read",
    "INSERT": "add",
    "UPDATE": "change",
    "DELETE": "delete",
    "TRUNCATE": "empty",
    "REFERENCES": "reference",
    "TRIGGER": "add triggers to",
}
COLUMN_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "REFERENCES")


def tables():
    """Every table the app's models use, and the migrations table, by name."""
    names = {model._meta.db_table for model in apps.get_app_config("core").get_models()}
    return sorted(names | {"django_migrations"})


def _columns(table):
    for model in apps.get_app_config("core").get_models():
        if model._meta.db_table == table:
            return [field.column for field in model._meta.concrete_fields]
    return []


def _ask(**checks):
    """Answer each check in one query, asked through the one owner row (it
    always exists) so no SQL is written by hand."""
    if not checks:
        return {}
    row = Owner.objects.annotate(**checks).values(*checks).first()
    return row or {}


def _check(function, *args, output=None):
    return Func(
        *(Value(arg) for arg in args),
        function=function,
        output_field=output or BooleanField(),
    )


def role_exists(role):
    found = _ask(found=_check("to_regrole", role, output=CharField()))
    return found.get("found") is not None


def grants(role):
    """What the role holds right now: table privileges per table, column
    privileges where the role has them on some columns but not the table, and
    whether it may create objects in the schema."""
    names = tables()
    checks = {}
    for t, table in enumerate(names):
        for p, privilege in enumerate(PRIVILEGES):
            checks[f"t{t}_{p}"] = _check("has_table_privilege", role, table, privilege)
        for p, privilege in enumerate(COLUMN_PRIVILEGES):
            checks[f"a{t}_{p}"] = _check(
                "has_any_column_privilege", role, table, privilege
            )
    checks["schema_create"] = _check("has_schema_privilege", role, SCHEMA, "CREATE")
    answer = _ask(**checks)
    held = {
        table: [p for i, p in enumerate(PRIVILEGES) if answer[f"t{t}_{i}"]]
        for t, table in enumerate(names)
    }
    partial = [
        (table, privilege)
        for t, table in enumerate(names)
        for i, privilege in enumerate(COLUMN_PRIVILEGES)
        if answer[f"a{t}_{i}"] and privilege not in held[table]
    ]
    columns = {}
    column_checks = {}
    for n, (table, privilege) in enumerate(partial):
        for c, column in enumerate(_columns(table)):
            column_checks[f"c{n}_{c}"] = _check(
                "has_column_privilege", role, table, column, privilege
            )
    answer_columns = _ask(**column_checks)
    for n, (table, privilege) in enumerate(partial):
        found = [
            column
            for c, column in enumerate(_columns(table))
            if answer_columns[f"c{n}_{c}"]
        ]
        columns.setdefault(table, {})[privilege] = found
    return {
        "tables": held,
        "columns": columns,
        "schema_create": bool(answer["schema_create"]),
    }


def _words(privileges):
    words = [PRIVILEGES[p] for p in privileges]
    if len(words) == 1:
        return words[0].capitalize()
    return (", ".join(words[:-1]) + " and " + words[-1]).capitalize()


def can_and_cannot(held):
    """Plain sentences from grants(): tables grouped by the same set of rights,
    column rights one table at a time, and each right the role lacks with the
    tables it lacks it on."""
    groups = {}
    for table, privileges in held["tables"].items():
        if privileges:
            groups.setdefault(tuple(privileges), []).append(table)
    can = [
        f"{_words(privileges)} rows in: {', '.join(names)}."
        for privileges, names in sorted(groups.items(), key=lambda g: -len(g[0]))
    ]
    for table, by_privilege in sorted(held["columns"].items()):
        for privilege, columns in by_privilege.items():
            can.append(
                f"{_words([privilege])} only these columns of {table}: "
                f"{', '.join(columns)}."
            )
    if held["schema_create"]:
        can.append(f"Create tables and other objects in the {SCHEMA} schema.")
    cannot = []
    everything = list(held["tables"])
    for privilege in PRIVILEGES:
        lacking = [
            t
            for t in everything
            if privilege not in held["tables"][t]
            and privilege not in held["columns"].get(t, {})
        ]
        if not lacking:
            continue
        where = "any table" if lacking == everything else ", ".join(lacking)
        cannot.append(f"{_words([privilege])} rows in: {where}.")
    if not held["schema_create"]:
        cannot.append(f"Create tables or other objects in the {SCHEMA} schema.")
    return can, cannot


def _when(value):
    return value.isoformat() if value else None


def _last(event):
    entry = AuditLog.objects.filter(event=event).order_by("-seq").first()
    return entry.created_at if entry else None


def _connection(role):
    """(connected as a member of the role, connected as a superuser). A
    superuser is a member of every role, so that does not count."""
    found = _ask(
        superuser=_check("current_setting", "is_superuser", output=CharField())
    )
    superuser = found.get("superuser") == "on"
    if superuser or not role_exists(role):
        return False, superuser
    member = _ask(member=_check("pg_has_role", role, "MEMBER")).get("member")
    return bool(member), superuser


def _database_role(role, name, purpose, credential, now):
    connected, superuser = _connection(role)
    entry = {
        "id": f"database_{role}",
        "name": name,
        "purpose": purpose,
        "role": role,
        "credential": credential,
        "expires": None,
        "expiry": "No expiry. Rotate the password as docs/ACCESS.md says.",
        "last_used": _when(now) if connected else None,
        "connected_now": connected,
        "warning": "The API is connected as a superuser, not as this role."
        if superuser
        else None,
        "checked_by_app": True,
        "revocable_here": False,
        "revoke": None,
    }
    if not role_exists(role):
        entry.update(
            grants=None,
            can=[],
            cannot=["The role does not exist in this database."],
        )
        return entry
    held = grants(role)
    can, cannot = can_and_cannot(held)
    entry.update(grants=held, can=can, cannot=cannot)
    return entry


def _sessions(now, current):
    live = []
    for session in Session.objects.filter(revoked_at=None).order_by("created_at"):
        expires = min(
            session.last_seen_at + sessions.IDLE,
            session.authenticated_at + sessions.ABSOLUTE,
        )
        if expires <= now:
            continue
        live.append(
            {
                "signed_in_at": _when(session.authenticated_at),
                "last_used": _when(session.last_seen_at),
                "expires": _when(expires),
                "elevated_until": _when(session.elevated_until)
                if sessions.is_elevated(session)
                else None,
                "current": session.id == current.id,
            }
        )
    return {
        "id": "owner_sessions",
        "name": "Your signed-in sessions",
        "can": [
            "Read and change everything in the admin.",
            "Start a vital action, once the passkey is confirmed again.",
        ],
        "cannot": [
            "Run a vital action before its 24-hour wait.",
            "Last longer than 15 minutes idle or 8 hours in all.",
            "Stay confirmed for vital actions longer than 5 minutes.",
        ],
        "credential": "Random token in a cookie the page cannot read; only its "
        "hash is stored.",
        "expires": max((s["expires"] for s in live), default=None),
        "expiry": "15 minutes idle, 8 hours at most.",
        "last_used": max((s["last_used"] for s in live), default=None),
        "checked_by_app": True,
        "revocable_here": True,
        "revoke": {
            "method": "POST",
            "path": "/api/v1/admin/sessions/revoke-all",
            "needs": "passkey confirmation",
        },
        "items": live,
    }


def _passkeys():
    items = [
        {
            "id": str(passkey.id),
            "name": passkey.name,
            "created_at": _when(passkey.created_at),
            "last_used": _when(passkey.last_used_at),
        }
        for passkey in AdminCredential.objects.order_by("created_at")
    ]
    return {
        "id": "owner_passkeys",
        "name": "Your passkeys",
        "can": [
            "Sign in to the admin, together with Cloudflare Access.",
            "Confirm a vital action.",
        ],
        "cannot": [
            "Sign in without Cloudflare Access letting the request through.",
            "Be copied from the site: only the public key is stored.",
        ],
        "credential": "Passkey (WebAuthn) held on your device; the site keeps "
        "the public key.",
        "expires": None,
        "expiry": "No expiry. Remove one you no longer use.",
        "last_used": max(
            (i["last_used"] for i in items if i["last_used"]), default=None
        ),
        "checked_by_app": True,
        "revocable_here": True,
        "revoke": {
            "method": "POST",
            "path": "/api/v1/admin/vital-actions/request",
            "kind": "revoke_passkey",
            "needs": "passkey confirmation and the 24-hour wait",
        },
        "items": items,
    }


def _fixed(entry):
    base = {
        "expires": None,
        "last_used": None,
        "checked_by_app": False,
        "revocable_here": False,
        "revoke": None,
        "note": NOT_CHECKED,
    }
    base.update(entry)
    return base


def review(current):
    """Every principal, in the order the page shows them."""
    now = timezone.now()
    owner = Owner.objects.get()
    deploy_called = SiteSettings.objects.values_list(
        "deploy_called_at", flat=True
    ).first()
    recovery_used = _last("recovery_used")
    access_set = all(
        (
            settings.CF_ACCESS_TEAM_DOMAIN,
            settings.CF_ACCESS_AUD,
            settings.CF_ACCESS_EMAIL,
        )
    )
    return [
        _sessions(now, current),
        _passkeys(),
        _database_role(
            APP_ROLE,
            "Website database role",
            "What the running API connects as.",
            "Password of a login user that is a member of app_rw, kept in the "
            "secret store.",
            now,
        ),
        _database_role(
            MIGRATION_ROLE,
            "Schema migration role",
            "Changes the schema at deploy time only.",
            "Password of a login user that is a member of migrator, used only by "
            "the deploy pipeline after a manual approval.",
            now,
        ),
        _fixed(
            {
                "id": "deploy_pipeline",
                "name": "Deploy pipeline",
                "can": ["Build the images and deploy a new version of the API."],
                "cannot": [
                    "Read content or messages.",
                    "Deploy to production without the manual approval.",
                ],
                "credential": "GitHub Actions with Workload Identity Federation: "
                "a short-lived Google token for each run, no stored key.",
                "expiry": "Each token lasts one pipeline run.",
                "note": "Not checked by the app. Set up with the deploy "
                "pipeline (Phase 7).",
            }
        ),
        _fixed(
            {
                "id": "pages_deploy_hook",
                "name": "Pages deploy hook",
                "can": ["Start a rebuild of the public site from the main branch."],
                "cannot": ["Change what is built, or read anything."],
                "credential": "Secret URL kept in the secret store.",
                "configured": bool(settings.PAGES_DEPLOY_HOOK_URL),
                "last_used": _when(deploy_called),
                "checked_by_app": True,
                "expiry": "No expiry. Rotate it as docs/ACCESS.md says.",
                "note": "Whether it is set and when it was last called are "
                "checked; what it can do is not.",
            }
        ),
        _fixed(
            {
                "id": "cloudflare_api_token",
                "name": "Cloudflare API token",
                "can": ["Purge the site's cache in its one zone."],
                "cannot": [
                    "Change DNS, firewall rules, Access policies or any other setting.",
                    "Read or change the site's content.",
                ],
                "credential": "API token scoped to cache purge, kept in the "
                "secret store.",
                "configured": bool(settings.CLOUDFLARE_PURGE_TOKEN),
                "expiry": "Set in Cloudflare when the token is made.",
                "note": "Whether it is set is checked; its scope is not.",
            }
        ),
        _fixed(
            {
                "id": "cloudflare_access",
                "name": "Cloudflare Access gate",
                "can": [
                    "Let a request reach the admin routes, for the one email "
                    "address its policy names.",
                ],
                "cannot": [
                    "Sign in by itself: a passkey is still needed.",
                    "Reach the admin when the API's Access settings are missing.",
                ],
                "credential": "Token Cloudflare signs for each request, checked "
                "by the API on every admin request.",
                "configured": access_set,
                "last_used": _when(now),
                "checked_by_app": True,
                "expiry": "Session length set in the Access policy.",
                "note": "This request passed it. The policy itself is not "
                "checked by the app.",
            }
        ),
        _fixed(
            {
                "id": "recovery_key",
                "name": "Offline recovery key",
                "can": [
                    "Replace every passkey with a new one, end every session and "
                    "cancel pending vital actions (Cloudflare Access is still "
                    "needed).",
                ],
                "cannot": [
                    "Be shown again: only its hash is stored.",
                    "Be used twice: a new key is issued each time.",
                ],
                "credential": "Random key printed once, kept offline.",
                "configured": bool(owner.recovery_key_hash),
                "issued_at": _when(recovery_used or owner.bootstrapped_at),
                "last_used": _when(recovery_used),
                "checked_by_app": True,
                "expiry": "No expiry. Using it replaces it.",
                "note": "Whether it is set and when it was last used are "
                "checked; where it is kept is not.",
            }
        ),
    ]
