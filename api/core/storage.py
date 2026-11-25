"""Where media files and CV files live. Local disk in development, Google Cloud
Storage in production; anything with save, read and delete can replace them
(R2 later).

Keys are made here and each store takes one pattern, so a key can never name a
path outside its store, whichever backend is in use. CV files have their own
pattern and their own place (a folder beside the media root, or a bucket of
their own), so a media key never reaches a CV and the other way round. Neither
store is ever served from a public URL: files reach a browser only through the
API's own routes.
"""

import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from django.conf import settings

KEY = re.compile(r"[0-9a-f]{32}-[0-9]{2,4}\.webp")
CV_KEY = re.compile(r"cv/[0-9a-f]{32}\.pdf")
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


def new_cv_key():
    return f"cv/{secrets.token_hex(16)}.pdf"


def _checked(key, pattern=KEY):
    if not isinstance(key, str) or not pattern.fullmatch(key):
        raise BadKey(key)
    return key


class LocalStorage:
    def __init__(self, root, pattern=KEY):
        self.root = Path(root).resolve()
        self.pattern = pattern
        self._root_prefix = os.path.realpath(self.root) + os.sep

    def _path(self, key):
        full = os.path.realpath(os.path.join(self.root, _checked(key, self.pattern)))
        if not full.startswith(self._root_prefix):
            raise BadKey(key)
        return Path(full)

    def save(self, key, data, content_type):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
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

    def __init__(self, bucket, pattern=KEY):
        self.bucket = quote(bucket, safe="")
        self.pattern = pattern

    def _name(self, key):
        return quote(_checked(key, self.pattern), safe="")

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
        return f"{self.API}/storage/v1/b/{self.bucket}/o/{self._name(key)}"

    def save(self, key, data, content_type):
        url = (
            f"{self.API}/upload/storage/v1/b/{self.bucket}/o"
            f"?uploadType=media&name={self._name(key)}"
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


def cv_backend():
    """The private CV store. Same backend kind as media, never the same place."""
    if settings.MEDIA_STORAGE == "gcs":
        if not settings.GCS_CV_BUCKET:
            raise NotConfigured("GCS_CV_BUCKET is not set")
        return GcsStorage(settings.GCS_CV_BUCKET, CV_KEY)
    if settings.MEDIA_STORAGE == "local":
        return LocalStorage(settings.CV_ROOT, CV_KEY)
    raise NotConfigured("MEDIA_STORAGE must be local or gcs")
