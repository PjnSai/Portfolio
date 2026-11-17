"""Passkeys (WebAuthn). Challenges live in Redis and work once.

Sign-in gives nothing away: no credential list in the options, and a signature
is verified against a throwaway key when the passkey is unknown, so every
failure costs the same work and returns the same answer.
"""

import json
from urllib.parse import urlsplit

import cbor2
from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings
from django.utils import timezone
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from core import cache
from core.models import AdminCredential

CHALLENGE_SECONDS = 300
USER_ID = b"portfolio-admin"


def _throwaway_key():
    numbers = ec.generate_private_key(ec.SECP256R1()).public_key().public_numbers()
    return cbor2.dumps(
        {
            1: 2,
            3: -7,
            -1: 1,
            -2: numbers.x.to_bytes(32, "big"),
            -3: numbers.y.to_bytes(32, "big"),
        }
    )


DUMMY_PUBLIC_KEY = _throwaway_key()


def _rp_id():
    return urlsplit(settings.SITE_ORIGIN).hostname or ""


def _challenge_name(purpose, scope, challenge):
    return f"challenge:{purpose}:{scope}:{bytes_to_base64url(challenge)}"


def _remember(purpose, scope, challenge):
    cache.client().set(
        _challenge_name(purpose, scope, challenge), 1, ex=CHALLENGE_SECONDS
    )


def _consume(purpose, scope, challenge):
    """True once, and only for a challenge this server issued for this purpose."""
    return cache.client().delete(_challenge_name(purpose, scope, challenge)) == 1


def _claimed_challenge(credential):
    try:
        client_data = base64url_to_bytes(credential["response"]["clientDataJSON"])
        return base64url_to_bytes(json.loads(client_data)["challenge"])
    except (KeyError, TypeError, ValueError):
        return None


def _stored(credential):
    try:
        credential_id = base64url_to_bytes(credential["rawId"])
    except (KeyError, TypeError, ValueError):
        return None
    return AdminCredential.objects.filter(credential_id=credential_id).first()


def authentication_options(purpose, scope=""):
    options = generate_authentication_options(
        rp_id=_rp_id(), user_verification=UserVerificationRequirement.REQUIRED
    )
    _remember(purpose, scope, options.challenge)
    body = json.loads(options_to_json(options))
    body.pop("allowCredentials", None)
    return body


def authenticate(credential, purpose, scope=""):
    """The matching AdminCredential, or None. Always verifies one signature."""
    challenge = _claimed_challenge(credential)
    issued = challenge is not None and _consume(purpose, scope, challenge)
    stored = _stored(credential)
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=challenge or b"",
            expected_rp_id=_rp_id(),
            expected_origin=settings.SITE_ORIGIN,
            credential_public_key=stored.public_key if stored else DUMMY_PUBLIC_KEY,
            credential_current_sign_count=stored.sign_count if stored else 0,
            require_user_verification=True,
        )
    except Exception:
        return None
    if not (issued and stored):
        return None
    stored.sign_count = verified.new_sign_count
    stored.last_used_at = timezone.now()
    stored.save(update_fields=["sign_count", "last_used_at"])
    return stored


def registration_options(purpose, scope=""):
    # Passkeys already enrolled are excluded, so one cannot be added twice.
    enrolled = AdminCredential.objects.values_list("credential_id", flat=True)
    options = generate_registration_options(
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=bytes(credential_id))
            for credential_id in enrolled
        ],
        rp_id=_rp_id(),
        rp_name="Portfolio admin",
        user_name="admin",
        user_id=USER_ID,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    _remember(purpose, scope, options.challenge)
    return json.loads(options_to_json(options))


def register(credential, name, purpose, scope=""):
    """Store a new passkey's public key and return it, or None if it fails."""
    challenge = _claimed_challenge(credential)
    if challenge is None or not _consume(purpose, scope, challenge):
        return None
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=_rp_id(),
            expected_origin=settings.SITE_ORIGIN,
            require_user_verification=True,
        )
    except Exception:
        return None
    if AdminCredential.objects.filter(credential_id=verified.credential_id).exists():
        return None
    return AdminCredential.objects.create(
        credential_id=verified.credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        name=name,
    )
