"""The public contact form: the form-start token, input cleaning,
rate limits, bot checks and storage.

Nothing here logs or keeps a message body, an email address or a raw client
address. Addresses and emails reach Redis and the database only as keyed
hashes. Redis or the database being down raises, and the view answers 503: the
form fails closed.
"""

import hashlib
import hmac
import re
import time
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import timezone

from core import cache, ratelimit
from core.models import ContactMessage

DAY = 86400
HOUR = 3600

NAME_MAX = 100
EMAIL_MAX = 254
BODY_MIN = 10
BODY_MAX = 4000


def _span(*pairs):
    """A character class from code point ranges, written as numbers so that no
    invisible character sits in this file."""
    return "[" + "".join(f"{chr(low)}-{chr(high)}" for low, high in pairs) + "]"


# Anything that is not text a person typed: control characters, and the marks
# that reorder or hide text. New lines are handled before this runs.
HIDDEN = re.compile(
    _span(
        (0x00, 0x08),
        (0x0B, 0x1F),
        (0x7F, 0x9F),
        (0x200B, 0x200F),
        (0x202A, 0x202E),
        (0x2060, 0x2064),
        (0x2066, 0x2069),
        (0xFEFF, 0xFEFF),
    )
)
LINE_BREAKS = re.compile(
    _span((0x0A, 0x0A), (0x0D, 0x0D), (0x85, 0x85), (0x2028, 0x2029))
)
EMAIL_BAD = re.compile(r'[\s"<>,;()\[\]\\]')
LINKS = re.compile(r"https?://|www\.", re.IGNORECASE)
DIGITS = re.compile(r"[0-9]{1,12}")


def now():
    return time.time()


def _sign(purpose, text):
    key = settings.SECRET_KEY.encode()
    return hmac.new(key, f"{purpose}:{text}".encode(), hashlib.sha256).hexdigest()


def address_hash(address):
    """What is stored and counted instead of a client address."""
    return _sign("contact-address", address)


def _email_hash(email):
    return _sign("contact-email", email.strip().lower())


def _body_hash(body):
    return _sign("contact-body", " ".join(body.lower().split()))


# The signed tokens


def form_token(started):
    """Signed time the form was opened, so the server can tell a person from a
    script that posts at once. The server keeps nothing for it."""
    stamp = str(int(started))
    return f"{stamp}.{_sign('contact-form', stamp)}"


def seconds_open(token):
    """Seconds since the form was opened, or None if the token is not ours,
    is from the future or is older than the form may stay open."""
    if not isinstance(token, str):
        return None
    stamp, _, signature = token.partition(".")
    if not DIGITS.fullmatch(stamp) or not hmac.compare_digest(
        signature, _sign("contact-form", stamp)
    ):
        return None
    elapsed = now() - int(stamp)
    if elapsed < -5 or elapsed > settings.CONTACT_FORM_TOKEN_SECONDS:
        return None
    return max(0, elapsed)


def start():
    """The signed form-start token, fetched when the form is opened."""
    return {"started": form_token(now())}


# Cleaning


def clean(data):
    """(values, errors) from the name, email and message as sent."""
    values, errors = {}, {}
    for field in ("name", "email", "body"):
        value = data.get(field)
        if field not in data:
            errors[field] = ["This field is required."]
        elif not isinstance(value, str):
            errors[field] = ["Enter text."]
        else:
            values[field], problem = _clean_field(field, value)
            if problem:
                errors[field] = [problem]
    return values, errors


def _clean_field(field, value):
    if field == "body":
        value = value.replace("\r\n", "\n")
        value = LINE_BREAKS.sub("\n", value)
    elif LINE_BREAKS.search(value):
        return "", "Keep this to one line."
    value = HIDDEN.sub("", value.replace("\t", " ")).strip()
    if field == "name":
        return value, _length(value, 1, NAME_MAX, "Enter your name.")
    if field == "email":
        return value, _email_problem(value)
    return value, _length(value, BODY_MIN, BODY_MAX, "Write a little more.")


def _length(value, low, high, short):
    if len(value) < low:
        return short
    if len(value) > high:
        return f"Use {high} characters or fewer."
    return None


def _email_problem(value):
    if not value or len(value) > EMAIL_MAX:
        return "Enter a valid email address."
    if EMAIL_BAD.search(value) or value.count("@") != 1:
        return "Enter a valid email address."
    try:
        validate_email(value)
    except ValidationError:
        return "Enter a valid email address."
    return None


# Limits


class Limited(Exception):
    """Over a limit; seconds says how long until the window ends."""

    def __init__(self, seconds):
        super().__init__("rate limited")
        self.seconds = seconds


def _window(seconds):
    start = int(now() // seconds)
    return start, int(seconds - (now() % seconds)) or 1


def _over(bucket, seconds, limit):
    window, left = _window(seconds)
    if ratelimit.hit(f"contact:{bucket}:{window}", seconds) > limit:
        raise Limited(left)


def count_start(address):
    _over(
        f"starts:{address_hash(address)}",
        HOUR,
        settings.CONTACT_STARTS_PER_HOUR,
    )


def count_attempt(address):
    _over(
        f"address:{address_hash(address)}", HOUR, settings.CONTACT_PER_ADDRESS_PER_HOUR
    )


def count_sender(email):
    _over(f"email:{_email_hash(email)}", DAY, settings.CONTACT_PER_EMAIL_PER_DAY)
    _over("global", DAY, settings.CONTACT_DAILY_CAP)


# Bot checks


def spam_outcome(values, honeypot, seconds):
    """The outcome code of the first bot check the message fails, else None."""
    if honeypot != "":
        return "spam_honeypot"
    if seconds < settings.CONTACT_MIN_SECONDS:
        return "spam_timing"
    if len(LINKS.findall(values["body"])) > settings.CONTACT_MAX_LINKS:
        return "spam_links"
    key = f"contact:body:{_body_hash(values['body'])}"
    if not cache.client().set(key, 1, nx=True, ex=DAY):
        return "spam_repeat"
    return None


def store(values, address, spam):
    created = timezone.now()
    return ContactMessage.objects.create(
        name=values["name"],
        email=values["email"],
        body=values["body"],
        status=ContactMessage.Status.SPAM if spam else ContactMessage.Status.NEW,
        created_at=created,
        expires_at=created + timedelta(days=settings.RETENTION_DAYS_MESSAGES),
        ip_hash=address_hash(address),
    )
