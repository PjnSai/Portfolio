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

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import timezone

from core import cache, ratelimit, retention
from core.models import ContactMessage

DAY = 86400
HOUR = 3600

REASONS = tuple(choice.value for choice in ContactMessage.Reason)
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
ELAPSED_MAX_MS = 7 * 24 * 3600 * 1000


def now():
    return time.time()


def _sign(purpose, text):
    key = settings.SECRET_KEY.encode()
    return hmac.new(key, f"{purpose}:{text}".encode(), hashlib.sha256).hexdigest()


def address_hash(address):
    """What is stored and counted instead of a client address."""
    return _sign("contact-address", address)


def email_hash(email):
    return _sign("contact-email", email.strip().lower())


def _body_hash(body):
    return _sign("contact-body", " ".join(body.lower().split()))


# How long the form was open


def seconds_open(elapsed):
    """Seconds the visitor's page says the form was open, or 0 if it says
    nothing usable. It comes from the visitor's own browser, so it only catches
    a script that posts at once and does not try to hide it; Turnstile is the
    real check. A whole number of milliseconds, not a boolean, up to a week."""
    if isinstance(elapsed, bool) or not isinstance(elapsed, int):
        return 0
    if not 0 <= elapsed <= ELAPSED_MAX_MS:
        return 0
    return elapsed / 1000


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
    # The reason is optional; a blank one is stored as none.
    reason = data.get("reason", "")
    if not isinstance(reason, str) or reason not in ("", *REASONS):
        errors["reason"] = ["Choose one of the options."]
    values["reason"] = reason if isinstance(reason, str) else ""
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


# Each takes the limits in force (core.limits.effective()), read once per
# submission.


def count_attempt(address, values):
    _over(f"address:{address_hash(address)}", HOUR, values["per_address_per_hour"])


def count_email(email, values):
    _over(f"email:{email_hash(email)}", DAY, values["per_email_per_day"])


def count_daily(spam, values):
    """Count a message against the day's cap for its kind. A message that is
    not spam over its cap raises Limited. Spam has its own cap and never
    raises: False means the spam cap is full and the message is not stored,
    though the sender is told it was received."""
    if spam:
        window, _ = _window(DAY)
        count = ratelimit.hit(f"contact:spam:{window}", DAY)
        return count <= values["spam_daily_cap"]
    _over("human", DAY, values["human_daily_cap"])
    return True


# Bot checks


# Words that mostly come from advertising. Each adds a few points; they never
# quarantine a message on their own, only together with other signs.
KEYWORDS = (
    "viagra",
    "cialis",
    "casino",
    "payday loan",
    "seo services",
    "backlinks",
    "forex",
    "lottery",
    "guaranteed income",
    "crypto investment",
)
KEYWORD_POINTS = 25
KEYWORD_MAX = 75
LINK_POINTS = 20
HARD = 100


def claim_body(text):
    """True if no stored message had this body in the last day. It takes the
    body's marker; release_body() gives it back if the message is not stored."""
    return bool(cache.client().set(_body_key(text), 1, nx=True, ex=DAY))


def release_body(text):
    cache.client().delete(_body_key(text))


def _body_key(text):
    return f"contact:body:{_body_hash(text)}"


def spam_score(values, honeypot, seconds, repeated, limits):
    """(score from 0 to 100, outcome code). The code names the first hard check
    the message fails, "spam_score" if only the points added up, else None. A
    filled honeypot, a rushed form, too many links or a repeated body each score
    the full 100; links and keywords score less on their own."""
    text = values["body"]
    links = len(LINKS.findall(text))
    keywords = sum(word in text.lower() for word in KEYWORDS)
    code = None
    score = min(KEYWORD_POINTS * keywords, KEYWORD_MAX) + LINK_POINTS * min(links, 5)
    if honeypot != "":
        score, code = score + HARD, "spam_honeypot"
    if seconds < limits["min_seconds"]:
        score, code = score + HARD, code or "spam_timing"
    if links > limits["max_links"]:
        score, code = score + HARD, code or "spam_links"
    if repeated:
        score, code = score + HARD, code or "spam_repeat"
    score = min(score, 100)
    if code is None and score >= limits["spam_threshold"]:
        code = "spam_score"
    return score, code


def store(values, address, score, spam):
    arrived = timezone.now()
    message = ContactMessage(
        name=values["name"],
        email=values["email"],
        body=values["body"],
        reason=values["reason"],
        spam_score=score,
        status=ContactMessage.Status.SPAM if spam else ContactMessage.Status.NEW,
        created_at=arrived,
        spam_at=arrived if spam else None,
        ip_hash=address_hash(address),
    )
    retention.apply(message)
    message.save(force_insert=True)
    return message
