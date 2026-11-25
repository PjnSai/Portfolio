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

# Django sets HSTS, nosniff, Referrer-Policy, COOP and X-Frame-Options;
# core.headers adds only what Django lacks.
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "core.alerts.ServerErrorMiddleware",
    "core.headers.SecurityHeadersMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "core.cors.CorsMiddleware",
    "core.guard.GuardMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
]

# Cloud Run ends TLS and sets this header itself, so a client cannot spoof it.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

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

# CSRF token in a cookie, sent back in X-CSRF-Token. The cookie is HttpOnly:
# the page gets the token from the JSON body of GET /api/v1/admin/csrf.
CSRF_COOKIE_NAME = "__Host-csrf"
CSRF_COOKIE_SECURE = True
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Strict"
CSRF_COOKIE_PATH = "/"
CSRF_COOKIE_DOMAIN = None
CSRF_COOKIE_AGE = None
CSRF_HEADER_NAME = "HTTP_X_CSRF_TOKEN"
CSRF_TRUSTED_ORIGINS = [SITE_ORIGIN] if SITE_ORIGIN else []
CSRF_FAILURE_VIEW = "core.responses.csrf_failure"

# SHA-256 of the one-time token that enrols the first passkey. Empty closes it.
BOOTSTRAP_TOKEN_SHA256 = os.environ.get("BOOTSTRAP_TOKEN_SHA256", "")

ADMIN_REQUESTS_PER_MINUTE = 300
# Per client, for GET /api/v1/site and the public images together. The edge
# serves nearly all of these; this catches what gets past it.
PUBLIC_REQUESTS_PER_MINUTE = 120
LOGIN_MAX_FAILURES = 5
LOGIN_GLOBAL_MAX_FAILURES = 20

# Contact form (core.contact). Its limits have their own Redis buckets, apart
# from PUBLIC_REQUESTS_PER_MINUTE. The address is the client address from
# Cf-Connecting-Ip; see ratelimit.client_address for how far that is trusted.
# Used until the owner saves their own in the admin (core.retention).
RETENTION_SPAM_DAYS = 30
RETENTION_MESSAGE_DAYS = 365
# A message scoring this many (0 to 100) from the bot checks is quarantined.
CONTACT_SPAM_THRESHOLD = 100
CONTACT_PER_ADDRESS_PER_HOUR = 5
CONTACT_PER_EMAIL_PER_DAY = 3
# Messages that are not spam, a day. Spam that is stored has its own cap; past
# it, spam is answered as received but not stored.
CONTACT_DAILY_CAP = 25
CONTACT_SPAM_DAILY_CAP = 20
CONTACT_MIN_SECONDS = 3
CONTACT_MAX_LINKS = 2
# How long a blocked sender stays blocked unless the owner renews it.
BLOCKLIST_MONTHS = 12
# Cloudflare Turnstile (core.turnstile). With no secret key the form is
# refused (503), never open: production must set it. Development and tests use
# Cloudflare's published dummy keys (see tests/settings.py and docker-compose).
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "")
TURNSTILE_VERIFIER = os.environ.get(
    "TURNSTILE_VERIFIER", "core.turnstile.CloudflareVerifier"
)

# Dotted paths of classes with send(event, context), comma-separated, after the
# database notifier, which records alerts for the admin. That one does not count
# as telling the owner: with no other notifier configured, vital actions are
# refused because the owner could not be told.
NOTIFIERS = [
    "core.notify.DatabaseNotifier",
    *(path for path in os.environ.get("NOTIFIERS", "").split(",") if path),
]

# Alerts (core.alerts). Each threshold is a count inside a window in seconds;
# reaching it raises one alert, and the same kind does not alert again inside
# its window. No kind raises more than ALERT_DAILY_CAP alerts a UTC day.
ALERT_SIGN_IN_FAILURES = 5
ALERT_SIGN_IN_WINDOW = 15 * 60
ALERT_RATE_LIMITED = 100
ALERT_RATE_LIMITED_WINDOW = 10 * 60
ALERT_SERVER_ERRORS = 20
ALERT_SERVER_ERRORS_WINDOW = 5 * 60
ALERT_DAILY_CAP = 5

# Request bodies. The media upload route alone takes a larger multipart body,
# held in memory only (nothing is written to a temporary file).
MAX_BODY_BYTES = 1_000_000
MEDIA_MAX_BYTES = 8 * 1024 * 1024
MEDIA_MAX_PIXELS = 40_000_000
MEDIA_DAILY_UPLOADS = 50
# The public CV, a PDF (core.cv). Uploads count against MEDIA_DAILY_UPLOADS.
CV_MAX_BYTES = 5 * 1024 * 1024
# View links: per client an hour (before the human check), and for the whole
# site a day (only visitors who passed it). Copy requests share the contact
# form's limits.
CV_VIEW_PER_ADDRESS_PER_HOUR = 10
CV_VIEW_DAILY_CAP = 200
FILE_UPLOAD_HANDLERS = ["django.core.files.uploadhandler.MemoryFileUploadHandler"]
FILE_UPLOAD_MAX_MEMORY_SIZE = MEDIA_MAX_BYTES + 65_536
DATA_UPLOAD_MAX_NUMBER_FILES = 1

# "local" in development and tests, "gcs" in production.
MEDIA_STORAGE = os.environ.get("MEDIA_STORAGE", "local")
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", BASE_DIR / ".media"))
GCS_MEDIA_BUCKET = os.environ.get("GCS_MEDIA_BUCKET", "")
# CV files: private, in a folder beside the media root in development and a
# bucket of their own in production (core.storage.cv_backend).
CV_ROOT = Path(os.environ.get("CV_ROOT", MEDIA_ROOT.parent / ".cv"))
GCS_CV_BUCKET = os.environ.get("GCS_CV_BUCKET", "")

# Dotted path of a class with purge(). The default only logs.
CACHE_PURGER = os.environ.get("CACHE_PURGER", "core.purge.LogPurger")
CLOUDFLARE_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")
CLOUDFLARE_PURGE_TOKEN = os.environ.get("CLOUDFLARE_PURGE_TOKEN", "")

# Rebuilds the static site on Cloudflare Pages after a change goes live.
SITE_DEPLOYER = os.environ.get("SITE_DEPLOYER", "core.deploy.LogDeployer")
PAGES_DEPLOY_HOOK_URL = os.environ.get("PAGES_DEPLOY_HOOK_URL", "")

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
