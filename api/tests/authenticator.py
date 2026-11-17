"""A software passkey for tests: ES256 key, "none" attestation, user verified."""

import hashlib
import json
import os

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from webauthn.helpers import bytes_to_base64url as b64

UP, UV, AT = 0x01, 0x04, 0x40


class SoftAuthenticator:
    def __init__(self, origin="https://portfolio.test"):
        self.origin = origin
        self.rp_id = origin.split("//")[1]
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.sign_count = 0

    @property
    def cose_key(self):
        numbers = self.key.public_key().public_numbers()
        return cbor2.dumps(
            {
                1: 2,
                3: -7,
                -1: 1,
                -2: numbers.x.to_bytes(32, "big"),
                -3: numbers.y.to_bytes(32, "big"),
            }
        )

    def _auth_data(self, attested=False):
        self.sign_count += 1
        flags = UP | UV | (AT if attested else 0)
        data = hashlib.sha256(self.rp_id.encode()).digest()
        data += bytes([flags]) + self.sign_count.to_bytes(4, "big")
        if attested:
            data += bytes(16) + len(self.credential_id).to_bytes(2, "big")
            data += self.credential_id + self.cose_key
        return data

    def _client_data(self, kind, challenge, origin):
        return json.dumps(
            {
                "type": kind,
                "challenge": challenge,
                "origin": origin or self.origin,
                "crossOrigin": False,
            }
        ).encode()

    def create(self, options, origin=None):
        client_data = self._client_data("webauthn.create", options["challenge"], origin)
        attestation = cbor2.dumps(
            {"fmt": "none", "attStmt": {}, "authData": self._auth_data(attested=True)}
        )
        return {
            "id": b64(self.credential_id),
            "rawId": b64(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client_data),
                "attestationObject": b64(attestation),
                "transports": ["internal"],
            },
            "clientExtensionResults": {},
        }

    def get(self, options, origin=None, key=None, credential_id=None):
        client_data = self._client_data("webauthn.get", options["challenge"], origin)
        auth_data = self._auth_data()
        signature = (key or self.key).sign(
            auth_data + hashlib.sha256(client_data).digest(),
            ec.ECDSA(hashes.SHA256()),
        )
        raw_id = b64(credential_id or self.credential_id)
        return {
            "id": raw_id,
            "rawId": raw_id,
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client_data),
                "authenticatorData": b64(auth_data),
                "signature": b64(signature),
            },
            "clientExtensionResults": {},
        }
