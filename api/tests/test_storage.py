"""The Google Cloud Storage backend, without the network."""

import json

import pytest

from core import storage

KEY = "0123456789abcdef0123456789abcdef-480.webp"


class FakeResponse:
    def __init__(self, body=b"{}"):
        self.body = body

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake_open(request, timeout):
        calls.append(request)
        if "metadata.google.internal" in request.full_url:
            return FakeResponse(json.dumps({"access_token": "tok"}).encode())
        return FakeResponse(b"image-bytes")

    monkeypatch.setattr(storage, "urlopen", fake_open)
    return calls


def test_save_uploads_with_the_service_account_token(sent):
    storage.GcsStorage("site-media").save(KEY, b"data", "image/webp")

    token, upload = sent
    assert token.get_header("Metadata-flavor") == "Google"
    assert upload.get_method() == "POST"
    assert upload.full_url == (
        "https://storage.googleapis.com/upload/storage/v1/b/site-media/o"
        f"?uploadType=media&name={KEY}"
    )
    assert upload.get_header("Authorization") == "Bearer tok"
    assert upload.get_header("Content-type") == "image/webp"
    assert upload.data == b"data"


def test_read_and_delete_name_the_object(sent):
    backend = storage.GcsStorage("site-media")

    assert backend.read(KEY) == b"image-bytes"
    backend.delete(KEY)

    urls = [(r.get_method(), r.full_url) for r in sent if "googleapis" in r.full_url]
    base = f"https://storage.googleapis.com/storage/v1/b/site-media/o/{KEY}"
    assert urls == [("GET", base + "?alt=media"), ("DELETE", base)]


@pytest.mark.parametrize("key", ["../x.webp", "a/b.webp", "%2e%2e"])
def test_bad_keys_never_reach_the_network(sent, key):
    with pytest.raises(storage.BadKey):
        storage.GcsStorage("site-media").save(key, b"x", "image/webp")
    assert sent == []


def test_production_without_a_bucket_is_refused(settings):
    settings.MEDIA_STORAGE = "gcs"
    settings.GCS_MEDIA_BUCKET = ""

    with pytest.raises(storage.NotConfigured):
        storage.backend()
