"""The access review page: every principal, the database rights read from the
real grants, no secrets, and the revoke paths it names unchanged."""

import base64
import json

import pytest
from django.db import connection
from django.urls import resolve

from core import access_review
from core.authz import Level
from core.models import AdminCredential, Owner, Session
from tests.test_db_roles import roles  # noqa: F401

pytestmark = pytest.mark.django_db

PRINCIPALS = [
    "owner_sessions",
    "owner_passkeys",
    "database_app_rw",
    "database_migrator",
    "deploy_pipeline",
    "pages_deploy_hook",
    "cloudflare_api_token",
    "cloudflare_access",
    "recovery_key",
]
FIELDS = {
    "id",
    "name",
    "can",
    "cannot",
    "credential",
    "expires",
    "expiry",
    "last_used",
    "checked_by_app",
    "revocable_here",
    "revoke",
}


def page(api):
    response = api.get("/access")
    assert response.status_code == 200
    return {p["id"]: p for p in response.json()["principals"]}


def catalog(role):
    """The role's grants as information_schema reports them, written apart
    from the page's own way of asking."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT table_name, privilege_type FROM information_schema.table_privileges"
            " WHERE grantee = %s AND table_schema = 'public'",
            [role],
        )
        tables = {}
        for table, privilege in cursor.fetchall():
            tables.setdefault(table, set()).add(privilege)
        cursor.execute(
            "SELECT table_name, column_name, privilege_type"
            " FROM information_schema.column_privileges"
            " WHERE grantee = %s AND table_schema = 'public'",
            [role],
        )
        columns = {}
        for table, column, privilege in cursor.fetchall():
            if privilege not in tables.get(table, set()):
                columns.setdefault(table, {}).setdefault(privilege, set()).add(column)
        cursor.execute("SELECT has_schema_privilege(%s, 'public', 'CREATE')", [role])
        schema_create = cursor.fetchone()[0]
    return tables, columns, schema_create


def shown(grants):
    tables = {t: set(p) for t, p in grants["tables"].items() if p}
    columns = {
        t: {p: set(c) for p, c in by.items()} for t, by in grants["columns"].items()
    }
    return tables, columns, grants["schema_create"]


# The page


def test_access_review_needs_a_session(api, passkey):
    assert api.get("/access").status_code == 401


def test_access_review_lists_every_principal_with_the_same_fields(
    signed_in,
    roles,  # noqa: F811
):
    principals = signed_in.get("/access").json()["principals"]

    assert [p["id"] for p in principals] == PRINCIPALS
    for principal in principals:
        assert FIELDS <= set(principal), principal["id"]
        assert principal["can"] and principal["cannot"], principal["id"]
        assert isinstance(principal["revocable_here"], bool)


def test_only_sessions_and_passkeys_can_be_revoked_here(signed_in):
    principals = page(signed_in)

    revocable = {key for key, p in principals.items() if p["revocable_here"]}
    assert revocable == {"owner_sessions", "owner_passkeys"}
    assert all(
        p["revoke"] is None for key, p in principals.items() if key not in revocable
    )


def test_principals_the_app_cannot_inspect_say_so(signed_in):
    principals = page(signed_in)

    for key in ("deploy_pipeline", "cloudflare_api_token"):
        assert principals[key]["note"].startswith("Not checked by the app") or (
            "is not" in principals[key]["note"]
        )
    assert principals["deploy_pipeline"]["checked_by_app"] is False
    assert principals["cloudflare_api_token"]["checked_by_app"] is False
    assert "where it is kept is not" in principals["recovery_key"]["note"]


def test_the_revoke_paths_named_are_the_existing_routes(signed_in):
    principals = page(signed_in)

    sessions = principals["owner_sessions"]["revoke"]
    view = resolve(sessions["path"]).func
    assert sessions["method"] == "POST"
    assert view.__name__ == "revoke_all"
    assert view.admin_levels == {"POST": Level.ELEVATED}

    passkeys = principals["owner_passkeys"]["revoke"]
    view = resolve(passkeys["path"]).func
    assert (passkeys["method"], passkeys["kind"]) == ("POST", "revoke_passkey")
    assert view.__name__ == "vital_request"
    assert view.admin_levels == {"POST": Level.ELEVATED}


def test_revoking_all_sessions_still_works_as_before(elevated):
    assert elevated.post("/sessions/revoke-all").status_code == 200

    assert Session.objects.filter(revoked_at=None).count() == 0
    assert elevated.get("/access").status_code == 401


def test_sessions_are_listed_without_ids(signed_in, new_api, passkey):
    other = new_api()
    assert other.login(passkey).status_code == 200

    items = page(signed_in)["owner_sessions"]["items"]

    assert len(items) == 2
    assert [i["current"] for i in items] == [True, False]
    assert set(items[0]) == {
        "signed_in_at",
        "last_used",
        "expires",
        "elevated_until",
        "current",
    }
    text = json.dumps(items)
    for session in Session.objects.all():
        assert str(session.id) not in text
        assert session.token_hash not in text


def test_revoked_and_expired_sessions_are_not_listed(signed_in, new_api, passkey):
    from tests.conftest import age_sessions

    other = new_api()
    other.login(passkey)
    other.post("/logout")
    age_sessions(minutes=10)

    items = page(signed_in)["owner_sessions"]["items"]

    assert len(items) == 1


def test_passkeys_are_listed_with_their_id_for_revoking(signed_in):
    items = page(signed_in)["owner_passkeys"]["items"]

    passkey = AdminCredential.objects.get()
    assert items == [
        {
            "id": str(passkey.id),
            "name": "Test key",
            "created_at": passkey.created_at.isoformat(),
            "last_used": passkey.last_used_at.isoformat(),
        }
    ]


def test_settings_are_shown_only_as_set_or_not(signed_in, settings):
    settings.CLOUDFLARE_PURGE_TOKEN = ""
    settings.PAGES_DEPLOY_HOOK_URL = ""
    before = page(signed_in)
    settings.CLOUDFLARE_PURGE_TOKEN = "purge-token-value"  # noqa: S105

    after = page(signed_in)

    assert before["cloudflare_api_token"]["configured"] is False
    assert after["cloudflare_api_token"]["configured"] is True
    assert before["pages_deploy_hook"]["configured"] is False
    assert after["cloudflare_access"]["configured"] is True


def test_the_recovery_key_shows_whether_it_is_set_and_its_last_use(signed_in):
    principal = page(signed_in)["recovery_key"]

    assert principal["configured"] is False
    assert principal["last_used"] is None


# No secrets


def test_the_page_returns_no_secret_token_key_or_hash(signed_in, settings):
    settings.CLOUDFLARE_PURGE_TOKEN = "purge-token-value"  # noqa: S105
    settings.PAGES_DEPLOY_HOOK_URL = "https://hooks.example/deploy/secret-part"
    settings.TURNSTILE_SECRET_KEY = "turnstile-secret-value"  # noqa: S105
    Owner.objects.update(recovery_key_hash="pbkdf2_sha256$1$salt$recoveryhash")

    text = signed_in.get("/access").content.decode()

    passkey = AdminCredential.objects.get()
    secrets = [
        signed_in.cookie,
        signed_in.csrf,
        settings.SECRET_KEY,
        settings.AUDIT_CHAIN_KEY,
        settings.CLOUDFLARE_PURGE_TOKEN,
        "secret-part",
        settings.TURNSTILE_SECRET_KEY,
        settings.CF_ACCESS_AUD,
        settings.CF_ACCESS_EMAIL,
        settings.CF_ACCESS_TEAM_DOMAIN,
        settings.BOOTSTRAP_TOKEN_SHA256,
        "recoveryhash",
        "pbkdf2",
        bytes(passkey.public_key).hex(),
        bytes(passkey.credential_id).hex(),
        base64.urlsafe_b64encode(bytes(passkey.credential_id)).decode().rstrip("="),
        connection.settings_dict["PASSWORD"],
    ]
    for session in Session.objects.all():
        secrets += [str(session.id), session.token_hash]
    for secret in secrets:
        assert secret and secret not in text


def test_the_page_takes_no_parameters(signed_in):
    assert signed_in.get("/access", {"role": "postgres"}).status_code == 400


# The database roles, from the real grants


def test_app_role_rights_match_the_real_grants(signed_in, roles):  # noqa: F811
    grants = page(signed_in)["database_app_rw"]["grants"]

    assert shown(grants) == catalog("app_rw")


def test_migration_role_rights_match_the_real_grants(signed_in, roles):  # noqa: F811
    grants = page(signed_in)["database_migrator"]["grants"]

    assert shown(grants) == catalog("migrator")
    assert grants["schema_create"] is True


def test_a_change_to_the_grants_shows_on_the_page(signed_in, roles):  # noqa: F811
    with connection.cursor() as cursor:
        cursor.execute("GRANT TRUNCATE ON palettes TO app_rw")
        cursor.execute("REVOKE DELETE ON contacts FROM app_rw")
        cursor.execute("GRANT UPDATE (name) ON contacts TO app_rw")
        cursor.execute("REVOKE UPDATE ON contacts FROM app_rw")
        cursor.execute("GRANT UPDATE (name) ON contacts TO app_rw")

    principal = page(signed_in)["database_app_rw"]

    assert "TRUNCATE" in principal["grants"]["tables"]["palettes"]
    assert "DELETE" not in principal["grants"]["tables"]["contacts"]
    assert principal["grants"]["columns"]["contacts"] == {"UPDATE": ["name"]}
    assert shown(principal["grants"]) == catalog("app_rw")
    assert "Change only these columns of contacts: name." in principal["can"]


def test_app_role_sentences_follow_the_grants(signed_in, roles):  # noqa: F811
    principal = page(signed_in)["database_app_rw"]

    def line(start, where="can"):
        (found,) = [x for x in principal[where] if x.startswith(start)]
        return found

    assert "audit_log" in line("Read and add rows in:")
    assert set(
        line("Change only these columns of blocked_senders:")
        .split(": ")[1]
        .rstrip(".")
        .split(", ")
    ) == {"expires_at", "note", "hit_count", "last_hit_at"}
    assert line("Empty rows in:", "cannot") == "Empty rows in: any table."
    assert (
        "Create tables or other objects in the public schema." in (principal["cannot"])
    )
    deleting = line("Delete rows in:", "cannot")
    assert "audit_log" in deleting and "admin_owner" in deleting
    assert "contact_messages" not in deleting
    assert line("Read rows in:", "cannot") == "Read rows in: django_migrations."


def test_every_table_is_asked_about(signed_in, roles):  # noqa: F811
    from django.apps import apps

    grants = page(signed_in)["database_app_rw"]["grants"]

    tables = {m._meta.db_table for m in apps.get_app_config("core").get_models()}
    assert set(grants["tables"]) == tables | {"django_migrations"}


def test_a_role_that_does_not_exist_is_said_so(signed_in, monkeypatch):
    monkeypatch.setattr(access_review, "MIGRATION_ROLE", "no_such_role_here")

    principal = next(
        p
        for p in signed_in.get("/access").json()["principals"]
        if p.get("role") == "no_such_role_here"
    )

    assert principal["grants"] is None
    assert principal["cannot"] == ["The role does not exist in this database."]
    assert principal["connected_now"] is False


def test_a_superuser_connection_is_not_taken_for_the_app_role(
    signed_in,
    roles,  # noqa: F811
):
    principal = page(signed_in)["database_app_rw"]

    # The tests connect as the superuser, which is a member of every role.
    assert connection.settings_dict["USER"] == "postgres"
    assert principal["connected_now"] is False
    assert principal["last_used"] is None
    assert principal["warning"] == (
        "The API is connected as a superuser, not as this role."
    )


def test_a_connection_as_the_app_role_is_shown(signed_in, roles):  # noqa: F811
    with connection.cursor() as cursor:
        cursor.execute("SET ROLE app_rw")
        try:
            (principal,) = [
                p
                for p in access_review.review(Session.objects.get())
                if p["id"] == "database_app_rw"
            ]
        finally:
            cursor.execute("RESET ROLE")

    assert principal["connected_now"] is True
    assert principal["last_used"] is not None
    assert principal["warning"] is None


def test_no_hand_written_sql_reads_the_grants():
    import inspect

    source = inspect.getsource(access_review)

    for word in ("cursor", ".raw(", ".extra(", "RawSQL", "execute("):
        assert word not in source
