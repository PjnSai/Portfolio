"""Where media files live. Local disk in development, Google Cloud Storage in
production; anything with save, read and delete can replace them (R2 later).

Keys are made here and must match one pattern, so a key can never name a path
outside the store, whichever backend is in use.
"""

import json
import re
import secrets
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from django.conf import settings

KEY = re.compile(r"[0-9a-f]{32}-[0-9]{2,4}\.webp")
TIMEOUT = 10
MAX_READ = 16 * 1024 * 1024


class BadKey(ValueError):
    pass


class NotConfigured(RuntimeError):
    pass


def new_key():
    """128 random bits; each size of an image adds its width to this."""
    return secrets.token_hex(16)


def variant_key(base, width):
    key = f"{base}-{width}.webp"
    return _checked(key)


def _checked(key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise BadKey(key)
    return key


class LocalStorage:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def _path(self, key):
        path = (self.root / _checked(key)).resolve()
        if path.parent != self.root:
            raise BadKey(key)
        return path

    def save(self, key, data, content_type):
        path = self._path(key)
        self.root.mkdir(parents=True, exist_ok=True)
        with open(path, "xb") as handle:
            handle.write(data)

    def read(self, key):
        return self._path(key).read_bytes()

    def delete(self, key):
        self._path(key).unlink(missing_ok=True)


class GcsStorage:
    """The JSON API with the Cloud Run service account's token. The bucket is
    private; files reach visitors only through the API's public media route."""

    METADATA_URL = (
        "http://metadata.google.internal/computeMetadata/v1/"
        "instance/service-accounts/default/token"
    )
    API = "https://storage.googleapis.com"

    def __init__(self, bucket):
        self.bucket = quote(bucket, safe="")

    def _token(self):
        request = Request(  # noqa: S310 - fixed http URL on the metadata server.
            self.METADATA_URL, headers={"Metadata-Flavor": "Google"}
        )
        with urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
            return json.loads(response.read(65_536))["access_token"]

    def _send(self, method, url, data=None, content_type=None):
        headers = {"Authorization": f"Bearer {self._token()}"}
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(url, data=data, headers=headers, method=method)  # noqa: S310
        with urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
            return response.read(MAX_READ)

    def _object(self, key):
        return f"{self.API}/storage/v1/b/{self.bucket}/o/{_checked(key)}"

    def save(self, key, data, content_type):
        url = (
            f"{self.API}/upload/storage/v1/b/{self.bucket}/o"
            f"?uploadType=media&name={_checked(key)}"
        )
        self._send("POST", url, data, content_type)

    def read(self, key):
        return self._send("GET", self._object(key) + "?alt=media")

    def delete(self, key):
        self._send("DELETE", self._object(key))


def backend():
    if settings.MEDIA_STORAGE == "gcs":
        if not settings.GCS_MEDIA_BUCKET:
            raise NotConfigured("GCS_MEDIA_BUCKET is not set")
        return GcsStorage(settings.GCS_MEDIA_BUCKET)
    if settings.MEDIA_STORAGE == "local":
        return LocalStorage(settings.MEDIA_ROOT)
    raise NotConfigured("MEDIA_STORAGE must be local or gcs")
