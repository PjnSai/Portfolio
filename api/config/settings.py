import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ImproperlyConfigured(f"{name} is not set")
    return value


def database_from_url(url: str) -> dict:
    parts = urlsplit(url)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise ImproperlyConfigured("DATABASE_URL must be a postgres URL")
    config = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parts.path.lstrip("/")),
        "USER": unquote(parts.username or ""),
        "PASSWORD": unquote(parts.password or ""),
        "HOST": parts.hostname or "",
        "PORT": str(parts.port or ""),
    }
    if "sslmode=require" in parts.query:
        config["OPTIONS"] = {"sslmode": "require"}
    return config


SECRET_KEY = required_env("DJANGO_SECRET_KEY")
DEBUG = os.environ.get("DJANGO_DEBUG") == "1"
ALLOWED_HOSTS = [
    host for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") if host
]

# No django.contrib auth, sessions or admin: passkeys and sessions live in core.
INSTALLED_APPS = [
    "rest_framework",
    "core",
]

# Security headers are set in core.headers and nowhere else.
MIDDLEWARE = [
    "core.headers.SecurityHeadersMiddleware",
    "django.middleware.common.CommonMiddleware",
    "core.guard.GuardMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
APPEND_SLASH = False

DATABASES = {}
if os.environ.get("DATABASE_URL"):
    DATABASES["default"] = database_from_url(os.environ["DATABASE_URL"])

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = os.environ.get("REDIS_URL", "")
AUDIT_CHAIN_KEY = required_env("AUDIT_CHAIN_KEY")

# Admin guard. If any of these four is empty, every admin request is refused.
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "")
CF_ACCESS_TEAM_DOMAIN = os.environ.get("CF_ACCESS_TEAM_DOMAIN", "")
CF_ACCESS_AUD = os.environ.get("CF_ACCESS_AUD", "")
CF_ACCESS_EMAIL = os.environ.get("CF_ACCESS_EMAIL", "")

# SHA-256 of the one-time token that enrols the first passkey. Empty closes it.
BOOTSTRAP_TOKEN_SHA256 = os.environ.get("BOOTSTRAP_TOKEN_SHA256", "")

ADMIN_REQUESTS_PER_MINUTE = 120
LOGIN_MAX_FAILURES = 5
LOGIN_GLOBAL_MAX_FAILURES = 20

# Dotted paths of classes with send(event, context), comma-separated. With none
# configured, vital actions are refused because the owner could not be told.
NOTIFIERS = [path for path in os.environ.get("NOTIFIERS", "").split(",") if path]

LANGUAGE_CODE = "en-gb"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True


REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "UNAUTHENTICATED_USER": None,
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
