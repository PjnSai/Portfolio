"""python -m devmode check | serve [--port N]

check  runs the guards only and says whether local mode may start.
serve  starts the API on 127.0.0.1 with the stand-in Access gate.
"""

import argparse
import hashlib
import os
import secrets
import sys
from urllib.parse import urlsplit

from devmode import config, guards


def say(text):
    print(text, flush=True)


def prepare(bootstrap_sha256=""):
    """Check the inherited environment, set the dev one, start Django and
    check its settings again."""
    database = os.environ.get("DEV_DATABASE_URL") or config.DATABASE_URL
    redis = os.environ.get("DEV_REDIS_URL") or config.REDIS_URL
    where = urlsplit(database)
    say(
        "Reading DEV_DATABASE_URL and DEV_REDIS_URL (unset means the test "
        f"containers): database {where.path.lstrip('/')!r} on "
        f"{where.hostname}:{where.port}, Redis {redis.rsplit('@', 1)[-1]!r}."
    )
    guards.enforce(
        guards.inherited(os.environ)
        + guards.database_url(database)
        + guards.redis_url(redis)
    )
    os.environ.update(config.environment(database, redis, bootstrap_sha256))
    sys.path.insert(0, str(config.API))

    import django

    django.setup()
    from django.conf import settings

    guards.enforce(guards.loaded(settings, os.environ))


def create_database():
    import psycopg
    from django.conf import settings
    from psycopg import sql

    db = settings.DATABASES["default"]
    name = db["NAME"]
    guards.enforce([] if name.endswith("_dev") else [f"{name!r} does not end in _dev"])
    with psycopg.connect(
        host=db["HOST"],
        port=db["PORT"] or None,
        user=db["USER"],
        password=db["PASSWORD"],
        dbname="postgres",
        autocommit=True,
    ) as connection:
        found = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", [name]
        ).fetchone()
        if not found:
            say(f"Creating database {name}.")
            connection.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name))
            )


def migrate_and_grant():
    from django.core.management import call_command
    from django.db import connection

    say("Applying migrations to the dev database.")
    call_command("migrate", verbosity=0)
    say("Applying db/roles.sql and db/grants.sql to the dev database.")
    with connection.cursor() as cursor:
        for name in ("roles.sql", "grants.sql"):
            cursor.execute((config.API / "db" / name).read_text(encoding="utf-8"))


def check(args):
    prepare()
    say("Local mode checks passed.")


def serve(args):
    guards.enforce(guards.bind(args.host, args.port))
    bootstrap = secrets.token_urlsafe(24)
    prepare(hashlib.sha256(bootstrap.encode()).hexdigest())
    create_database()
    migrate_and_grant()

    from django.conf import settings
    from django.core.servers.basehttp import run
    from django.core.wsgi import get_wsgi_application

    from devmode import gate

    config.STATE.mkdir(exist_ok=True)
    say(f"Writing a new bootstrap token to {config.BOOTSTRAP_FILE}.")
    config.BOOTSTRAP_FILE.write_text(bootstrap, encoding="utf-8")

    key = gate.new_key()
    gate.install(key)
    app = gate.Gate(
        get_wsgi_application(),
        key,
        team=settings.CF_ACCESS_TEAM_DOMAIN,
        audience=settings.CF_ACCESS_AUD,
        email=settings.CF_ACCESS_EMAIL,
    )
    say(f"Local API on http://{args.host}:{args.port} (Access gate stood in).")
    try:
        run(args.host, args.port, app, ipv6=False, threading=True)
    except OSError as error:
        raise guards.Refused(
            f"  - Port {args.port} could not be opened ({error.strerror})."
        ) from error


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m devmode")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check").set_defaults(func=check, action="start")
    run = commands.add_parser("serve")
    run.add_argument("--host", default=config.API_HOST)
    run.add_argument("--port", type=int, default=config.API_PORT)
    run.set_defaults(func=serve, action="start")
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except guards.Refused as refused:
        print(f"Refusing to {args.action} local mode:\n{refused}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
