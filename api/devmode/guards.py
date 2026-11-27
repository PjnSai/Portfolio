"""Checks the launcher makes before it starts. Each returns a list of reasons
to refuse; an empty list means go ahead. Anything that cannot be checked is a
reason to refuse."""

import ipaddress
import socket
from urllib.parse import urlsplit

from devmode import config


class Refused(Exception):
    pass


DUMMY_TURNSTILE_SECRETS = frozenset(
    {
        "1x0000000000000000000000000000000AA",
        "2x0000000000000000000000000000000AA",
        "3x0000000000000000000000000000000AA",
    }
)
# Set only for production: Cloudflare, Cloud Storage and Resend credentials or
# names, the notice email addresses, and the variables Cloud Run sets in every
# container.
PRODUCTION_NAMES = (
    "CLOUDFLARE_PURGE_TOKEN",
    "CLOUDFLARE_ZONE_ID",
    "PAGES_DEPLOY_HOOK_URL",
    "GCS_MEDIA_BUCKET",
    "GCS_CV_BUCKET",
    "RESEND_API_KEY",
    "NOTICE_EMAIL_FROM",
    "NOTICE_EMAIL_TO",
    "K_SERVICE",
    "K_REVISION",
    "K_CONFIGURATION",
)
DEV_CHOICES = {
    "MEDIA_STORAGE": "local",
    "CACHE_PURGER": "core.purge.LogPurger",
    "SITE_DEPLOYER": "core.deploy.LogDeployer",
    "DJANGO_SETTINGS_MODULE": "config.settings",
}
# Notifiers that reach outside this computer. Local mode only logs notices.
PRODUCTION_NOTIFIERS = ("core.notify.ResendNotifier",)
LOCAL_NAMES = ("localhost", "127.0.0.1", "::1")
# Databases 14 and 15 belong to the browser tests and the tests, which empty them.
SHARED_REDIS = ("14", "15")


def enforce(problems):
    if problems:
        raise Refused("\n".join(f"  - {p}" for p in problems))


def is_local_origin(origin):
    try:
        parts = urlsplit(origin)
        return (
            parts.scheme == "http"
            and parts.hostname in ("localhost", "127.0.0.1")
            and parts.path == ""
            and not parts.query
            and parts.port in (None, *range(1, 65536))
        )
    except ValueError:
        return False


def inherited(env):
    """The environment the launcher was started with, before it sets its own."""
    problems = [
        f"{name} is set: that is a production value."
        for name in PRODUCTION_NAMES
        if env.get(name)
    ]
    secret = env.get("TURNSTILE_SECRET_KEY")
    if secret and secret not in DUMMY_TURNSTILE_SECRETS:
        problems.append(
            "TURNSTILE_SECRET_KEY is set to a real key, not Cloudflare's test key."
        )
    origin = env.get("SITE_ORIGIN")
    if origin and not is_local_origin(origin):
        problems.append(f"SITE_ORIGIN is {origin!r}, not a localhost address.")
    for name, wanted in DEV_CHOICES.items():
        value = env.get(name)
        if value and value != wanted:
            problems.append(f"{name} is {value!r}; local mode needs {wanted!r}.")
    problems += _notifiers(env.get("NOTIFIERS", "").split(","))
    return problems


def _notifiers(paths):
    return [
        f"NOTIFIERS names {path}: local mode only logs notices."
        for path in PRODUCTION_NOTIFIERS
        if path in [p.strip() for p in paths]
    ]


def is_loopback_host(host, lookup=socket.getaddrinfo):
    if not host:
        return False
    if host in LOCAL_NAMES:
        return True
    try:
        found = {entry[4][0] for entry in lookup(host, None)}
        return bool(found) and all(ipaddress.ip_address(a).is_loopback for a in found)
    except Exception:
        return False


def database_url(url, lookup=socket.getaddrinfo):
    try:
        parts = urlsplit(url)
        host, name = parts.hostname, parts.path.lstrip("/")
    except ValueError:
        return ["The database address cannot be read."]
    if parts.scheme not in ("postgres", "postgresql"):
        return ["The database address is not a postgres:// address."]
    problems = []
    if not name.endswith("_dev"):
        problems.append(f"The database name {name!r} does not end in _dev.")
    if not is_loopback_host(host, lookup):
        problems.append(f"The database host {host!r} is not on loopback (127.0.0.1).")
    return problems


def redis_url(url, lookup=socket.getaddrinfo):
    try:
        parts = urlsplit(url)
        host, number = parts.hostname, parts.path.lstrip("/") or "0"
    except ValueError:
        return ["The Redis address cannot be read."]
    if parts.scheme != "redis":
        return ["The Redis address is not a redis:// address."]
    problems = []
    if not is_loopback_host(host, lookup):
        problems.append(f"The Redis host {host!r} is not on loopback (127.0.0.1).")
    if number in SHARED_REDIS:
        problems.append(f"Redis database {number} belongs to the tests.")
    return problems


def bind(host, port):
    problems = []
    if host != config.API_HOST:
        problems.append(f"The server may bind only to 127.0.0.1, not {host!r}.")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        problems.append(f"The port {port!r} is not between 1024 and 65535.")
    return problems


def loaded(settings, env, lookup=socket.getaddrinfo):
    """The settings as Django loaded them, checked again after setup. A
    setting that is missing is a refusal."""
    try:
        return _loaded(settings, env, lookup)
    except Exception as error:
        return [f"The settings could not be checked ({type(error).__name__})."]


def _loaded(settings, env, lookup):
    problems = []
    if env.get("DJANGO_DEBUG") != "1" or settings.DEBUG is not True:
        problems.append("DEBUG is not on: the launcher did not set DJANGO_DEBUG.")
    db = settings.DATABASES["default"]
    if not db["NAME"].endswith("_dev"):
        problems.append(f"The database name {db['NAME']!r} does not end in _dev.")
    if not is_loopback_host(db["HOST"], lookup):
        problems.append(f"The database host {db['HOST']!r} is not on loopback.")
    problems += redis_url(settings.REDIS_URL, lookup)
    if not is_local_origin(settings.SITE_ORIGIN):
        problems.append("SITE_ORIGIN is not a localhost address.")
    if settings.TURNSTILE_SECRET_KEY not in DUMMY_TURNSTILE_SECRETS:
        problems.append("TURNSTILE_SECRET_KEY is not Cloudflare's test key.")
    if settings.MEDIA_STORAGE != "local":
        problems.append("MEDIA_STORAGE is not local.")
    for name in (
        "GCS_MEDIA_BUCKET",
        "GCS_CV_BUCKET",
        "CLOUDFLARE_PURGE_TOKEN",
        "CLOUDFLARE_ZONE_ID",
        "PAGES_DEPLOY_HOOK_URL",
        "RESEND_API_KEY",
        "NOTICE_EMAIL_FROM",
        "NOTICE_EMAIL_TO",
    ):
        if getattr(settings, name):
            problems.append(f"{name} is set.")
    for name in ("CACHE_PURGER", "SITE_DEPLOYER"):
        if getattr(settings, name) != DEV_CHOICES[name]:
            problems.append(f"{name} is not the logging one.")
    problems += _notifiers(settings.NOTIFIERS)
    if settings.CF_ACCESS_TEAM_DOMAIN != config.TEAM:
        problems.append("CF_ACCESS_TEAM_DOMAIN is not the local stand-in.")
    return problems
