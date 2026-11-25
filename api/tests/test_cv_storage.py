"""Private storage for CV files: its own key pattern, its own place, never the
media store and never a public URL."""

import json
from pathlib import Path

import pytest

from core import storage

GOOD = "cv/0123456789abcdef0123456789abcdef.pdf"

BAD = [
    "",
    "../x.pdf",
    "cv/../x.pdf",
    "cv/../../etc/passwd",
    "/cv/0123456789abcdef0123456789abcdef.pdf",
    "cv\\0123456789abcdef0123456789abcdef.pdf",
    "cv/0123456789abcdef0123456789abcde.pdf",
    "cv/0123456789ABCDEF0123456789ABCDEF.pdf",
    "cv/0123456789abcdef0123456789abcdef.PDF",
    "cv/0123456789abcdef0123456789abcdef.pdf\n",
    "cv/0123456789abcdef0123456789abcdef.pdf/../x",
    "cv/0123456789abcdef0123456789abcdef.pdf.exe",
    "cv%2f0123456789abcdef0123456789abcdef.pdf",
    "0123456789abcdef0123456789abcdef.pdf",
    "a\x00b",
    # A media key is not a CV key, and the other way round.
    "0123456789abcdef0123456789abcdef-480.webp",
]


def test_new_keys_are_random_pdf_names_under_their_own_prefix():
    first, second = storage.new_cv_key(), storage.new_cv_key()

    assert storage.CV_KEY.fullmatch(first)
    assert first.startswith("cv/") and first.endswith(".pdf")
    assert first != second


@pytest.mark.parametrize("key", BAD)
def test_bad_keys_are_refused_by_the_local_store(tmp_path, key):
    store = storage.LocalStorage(tmp_path, storage.CV_KEY)

    for call in (
        lambda: store.read(key),
        lambda: store.save(key, b"x", "application/pdf"),
        lambda: store.delete(key),
    ):
        with pytest.raises(storage.BadKey):
            call()
    assert list(tmp_path.iterdir()) == []


def test_a_cv_key_is_refused_by_the_media_store(tmp_path):
    with pytest.raises(storage.BadKey):
        storage.LocalStorage(tmp_path).save(GOOD, b"x", "application/pdf")


def test_round_trip_on_local_disk(tmp_path):
    store = storage.LocalStorage(tmp_path, storage.CV_KEY)

    store.save(GOOD, b"%PDF-1.7", "application/pdf")

    assert store.read(GOOD) == b"%PDF-1.7"
    assert (tmp_path / "cv" / "0123456789abcdef0123456789abcdef.pdf").exists()
    store.delete(GOOD)
    assert not (tmp_path / GOOD).exists()


def test_development_keeps_cvs_beside_the_media_root_not_in_it(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_ROOT = tmp_path / ".media"
    settings.CV_ROOT = tmp_path / ".cv"

    store = storage.cv_backend()
    store.save(GOOD, b"%PDF-1.7", "application/pdf")

    assert (tmp_path / ".cv" / GOOD).exists()
    assert not (tmp_path / ".media").exists()


def test_the_cv_folder_is_ignored_by_git():
    ignore = Path(__file__).resolve().parents[2] / ".gitignore"

    assert ".cv/" in ignore.read_text().split()


def test_the_default_cv_root_is_not_the_media_root():
    from django.conf import settings

    assert Path(settings.CV_ROOT).resolve() != Path(settings.MEDIA_ROOT).resolve()
    assert Path(settings.CV_ROOT).name == ".cv"


def test_production_without_a_cv_bucket_is_refused(settings):
    settings.MEDIA_STORAGE = "gcs"
    settings.GCS_MEDIA_BUCKET = "site-media"
    settings.GCS_CV_BUCKET = ""

    with pytest.raises(storage.NotConfigured):
        storage.cv_backend()


def test_production_never_uses_the_media_bucket_for_cvs(settings):
    settings.MEDIA_STORAGE = "gcs"
    settings.GCS_MEDIA_BUCKET = "site-media"
    settings.GCS_CV_BUCKET = "site-cv"

    store = storage.cv_backend()

    assert isinstance(store, storage.GcsStorage)
    assert store.bucket == "site-cv"


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
        return FakeResponse(b"%PDF-1.7")

    monkeypatch.setattr(storage, "urlopen", fake_open)
    return calls


def test_gcs_names_the_object_with_its_prefix_escaped(sent):
    store = storage.GcsStorage("site-cv", storage.CV_KEY)

    store.save(GOOD, b"%PDF-1.7", "application/pdf")
    assert store.read(GOOD) == b"%PDF-1.7"
    store.delete(GOOD)

    name = "cv%2F0123456789abcdef0123456789abcdef.pdf"
    urls = [(r.get_method(), r.full_url) for r in sent if "googleapis" in r.full_url]
    base = f"https://storage.googleapis.com/storage/v1/b/site-cv/o/{name}"
    assert urls == [
        (
            "POST",
            "https://storage.googleapis.com/upload/storage/v1/b/site-cv/o"
            f"?uploadType=media&name={name}",
        ),
        ("GET", base + "?alt=media"),
        ("DELETE", base),
    ]


@pytest.mark.parametrize("key", BAD)
def test_bad_keys_never_reach_gcs(sent, key):
    store = storage.GcsStorage("site-cv", storage.CV_KEY)

    with pytest.raises(storage.BadKey):
        store.save(key, b"x", "application/pdf")
    assert sent == []
