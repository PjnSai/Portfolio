"""CV versions in the admin: what an upload must pass, the live version, the
limit of ten, the owner's download and deleting a version."""

import hashlib
import io

import pytest

from core import storage
from core.models import AuditLog, CvVersion, PendingAction
from tests import pdfs
from tests.conftest import ADMIN, age_sessions, mature

pytestmark = pytest.mark.django_db

URL = "/cv/versions"


@pytest.fixture(autouse=True)
def cv_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_ROOT = tmp_path / "media"
    settings.CV_ROOT = tmp_path / "cv"
    settings.CV_MAX_BYTES = 50_000
    return settings.CV_ROOT


def upload(api, data, name="cv.pdf", content_type="application/pdf", extra=None):
    if api.csrf is None:
        api.fetch_csrf()
    handle = io.BytesIO(data)
    handle.name = name
    handle.content_type = content_type
    body = {"file": handle, **(extra or {})}
    return api.client.post(ADMIN + URL, body, secure=True, headers=api.headers())


def stored_files(root):
    return (
        sorted(p.name for p in root.rglob("*") if p.is_file()) if root.exists() else []
    )


def file_error(response):
    return response.json()["errors"]["file"][0]


def test_a_pdf_is_stored_privately_under_a_random_key(elevated, cv_root):
    response = upload(elevated, pdfs.GOOD)

    assert response.status_code == 201, response.content
    item = CvVersion.objects.get()
    assert storage.CV_KEY.fullmatch(item.storage_key)
    assert (cv_root / item.storage_key).read_bytes() == pdfs.GOOD
    assert item.size == len(pdfs.GOOD)
    assert item.sha256 == hashlib.sha256(pdfs.GOOD).hexdigest()
    assert item.is_live is False


def test_the_answer_never_holds_the_storage_key(elevated):
    response = upload(elevated, pdfs.GOOD)
    key = CvVersion.objects.get().storage_key

    assert key not in response.content.decode()
    assert key.split("/")[1].removesuffix(".pdf") not in response.content.decode()
    assert set(response.json()) == {
        "id",
        "size",
        "sha256",
        "created_at",
        "is_live",
        "file",
    }


def test_an_upload_is_audited_without_personal_data(elevated):
    upload(elevated, pdfs.GOOD)

    entry = AuditLog.objects.get(event="cv_uploaded")
    assert entry.detail == {
        "version": str(CvVersion.objects.get().id),
        "size": len(pdfs.GOOD),
    }


REJECTED = {
    "not a pdf renamed": (b"MZ\x90\x00 this is a program" * 10, "cv.pdf"),
    "zip with a pdf header": (pdfs.zip_with_pdf_header(), "cv.pdf"),
    "no end marker": (pdfs.GOOD.replace(b"%%EOF", b"%%EOX"), "cv.pdf"),
    "end marker too early": (pdfs.GOOD + b" " * 2000, "cv.pdf"),
    "encrypted": (pdfs.encrypted(), "cv.pdf"),
    **{name: (data, "cv.pdf") for name, data in pdfs.ACTIVE.items()},
    "pdf named as a word file": (pdfs.GOOD, "cv.docx"),
    "pdf with no extension": (pdfs.GOOD, "cv"),
}


@pytest.mark.parametrize("data,name", REJECTED.values(), ids=REJECTED.keys())
def test_files_that_are_not_a_plain_pdf_are_refused_before_anything_is_stored(
    elevated, cv_root, data, name
):
    response = upload(elevated, data, name=name)

    assert response.status_code == 400
    assert file_error(response)
    assert CvVersion.objects.count() == 0
    assert stored_files(cv_root) == []
    assert not AuditLog.objects.filter(event="cv_uploaded").exists()


def test_the_type_the_browser_declares_must_agree(elevated, cv_root):
    response = upload(elevated, pdfs.GOOD, content_type="application/zip")

    assert response.status_code == 400
    assert stored_files(cv_root) == []


def test_the_reasons_are_told_apart(elevated):
    encrypted = file_error(upload(elevated, pdfs.encrypted()))
    active = file_error(upload(elevated, pdfs.with_javascript()))
    other = file_error(upload(elevated, b"plain text"))

    assert "password" in encrypted.lower()
    assert "script" in active.lower() or "action" in active.lower()
    assert "PDF" in other
    assert len({encrypted, active, other}) == 3


def test_an_empty_file_is_refused(elevated, cv_root):
    response = upload(elevated, b"")

    assert response.status_code == 400
    assert stored_files(cv_root) == []


def test_an_oversize_file_is_refused(elevated, cv_root, settings):
    big = pdfs.pdf(stream=b"0" * settings.CV_MAX_BYTES)

    response = upload(elevated, big)

    assert response.status_code == 413
    assert "MB" in file_error(response)
    assert stored_files(cv_root) == []


def test_the_body_limit_for_the_upload_path_follows_the_cv_limit(elevated, settings):
    settings.CV_MAX_BYTES = 5 * 1024 * 1024
    big = pdfs.pdf(stream=b"0" * (5 * 1024 * 1024 + 70_000))

    response = upload(elevated, big)

    assert response.status_code == 413
    assert CvVersion.objects.count() == 0


def test_the_default_limit_is_five_megabytes():
    import config.settings

    assert config.settings.CV_MAX_BYTES == 5 * 1024 * 1024


def test_script_like_bytes_inside_page_content_are_not_mistaken(elevated):
    data = pdfs.pdf(stream=b"BT (/JS /AA /Launch) Tj ET")

    assert upload(elevated, data).status_code == 201


def test_other_form_fields_are_refused(elevated, cv_root):
    response = upload(elevated, pdfs.GOOD, extra={"live": "true"})

    assert response.status_code == 400
    assert stored_files(cv_root) == []


def test_upload_needs_a_session(api, passkey, cv_root):
    response = upload(api, pdfs.GOOD)

    assert response.status_code == 401
    assert stored_files(cv_root) == []


def test_upload_needs_a_fresh_passkey_confirmation(signed_in, cv_root):
    response = upload(signed_in, pdfs.GOOD)

    assert response.status_code == 403
    assert response.json()["code"] == "elevation_required"
    assert stored_files(cv_root) == []


def test_listing_needs_only_a_session(signed_in):
    response = signed_in.get(URL)

    assert response.status_code == 200
    assert response.json() == {"versions": [], "max_versions": 10}


def test_listing_shows_every_version_without_keys(elevated):
    upload(elevated, pdfs.GOOD)
    upload(elevated, pdfs.pdf(stream=b"BT (Two) Tj ET"))

    body = elevated.get(URL).content.decode()

    assert len(elevated.get(URL).json()["versions"]) == 2
    for key in CvVersion.objects.values_list("storage_key", flat=True):
        assert key not in body
        assert key[3:35] not in body


def test_at_most_ten_versions_are_kept(elevated, cv_root):
    for n in range(10):
        assert upload(elevated, pdfs.pdf(stream=b"(%d)" % n)).status_code == 201

    response = upload(elevated, pdfs.GOOD)

    assert response.status_code == 409
    assert response.json()["code"] == "cv_versions_full"
    assert "10" in response.json()["detail"]
    assert CvVersion.objects.count() == 10
    assert len(stored_files(cv_root)) == 10


def test_a_storage_failure_stores_nothing(elevated, monkeypatch):
    def broken(*args):
        raise OSError("disk full")

    monkeypatch.setattr(storage.LocalStorage, "save", broken)

    assert upload(elevated, pdfs.GOOD).status_code == 503
    assert CvVersion.objects.count() == 0


def test_a_database_failure_leaves_no_file(elevated, cv_root, monkeypatch):
    from django.db import OperationalError

    from core import audit

    def broken(*args, **kwargs):
        raise OperationalError("gone")

    monkeypatch.setattr(audit, "record", broken)

    assert upload(elevated, pdfs.GOOD).status_code == 503
    assert CvVersion.objects.count() == 0
    assert stored_files(cv_root) == []


# Live version


def uploaded(api, stream=b"(x)"):
    return upload(api, pdfs.pdf(stream=stream)).json()["id"]


def test_setting_a_version_live_replaces_the_one_before(elevated):
    first, second = uploaded(elevated, b"(1)"), uploaded(elevated, b"(2)")

    assert elevated.post(f"{URL}/{first}/live").status_code == 200
    assert elevated.post(f"{URL}/{second}/live").status_code == 200

    assert list(
        CvVersion.objects.filter(is_live=True).values_list("id", flat=True)
    ) == [CvVersion.objects.get(id=second).id]
    events = AuditLog.objects.filter(event="cv_live_changed")
    assert [e.detail for e in events] == [{"version": first}, {"version": second}]


def test_rolling_back_is_setting_an_older_version_live(elevated):
    first, second = uploaded(elevated, b"(1)"), uploaded(elevated, b"(2)")
    elevated.post(f"{URL}/{second}/live")

    elevated.post(f"{URL}/{first}/live")

    assert str(CvVersion.objects.get(is_live=True).id) == first


def test_setting_live_needs_a_fresh_passkey_confirmation(elevated):
    version = uploaded(elevated)
    age_sessions(minutes=6)

    response = elevated.post(f"{URL}/{version}/live")

    assert response.status_code == 403
    assert not CvVersion.objects.filter(is_live=True).exists()


def test_setting_an_unknown_version_live_is_not_found(elevated):
    response = elevated.post(f"{URL}/00000000-0000-4000-8000-000000000000/live")

    assert response.status_code == 404


# The owner's download


def test_the_owner_can_download_any_version_as_an_attachment(elevated):
    from core.models import SiteSettings

    SiteSettings.objects.create(published={"title": "Pujan Shahi"})
    version = uploaded(elevated, b"(old)")

    response = elevated.get(f"{URL}/{version}/file")

    assert response.status_code == 200
    assert b"".join(response.streaming_content) == pdfs.pdf(stream=b"(old)")
    assert response["Content-Type"] == "application/pdf"
    assert (
        response["Content-Disposition"] == 'attachment; filename="Pujan-Shahi-CV.pdf"'
    )
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Cache-Control"] == "no-store"
    assert response["X-Robots-Tag"] == "noindex"


def test_the_download_needs_a_session(elevated, new_api):
    version = uploaded(elevated)

    assert new_api().get(f"{URL}/{version}/file").status_code == 401


def test_a_missing_file_is_unavailable_not_an_error_page(elevated, cv_root):
    version = uploaded(elevated)
    (cv_root / CvVersion.objects.get().storage_key).unlink()

    assert elevated.get(f"{URL}/{version}/file").status_code == 503


# Deleting a version: a permanent delete, so a vital action


def request_delete(api, version):
    return api.post(
        "/vital-actions/request",
        {
            "kind": "permanent_delete",
            "payload": {"entity": "cv_version", "id": version},
        },
    )


def reconfirm(api, passkey):
    age_sessions(minutes=6)
    assert api.elevate(passkey).status_code == 200


def test_a_version_is_deleted_with_its_file_after_the_wait(
    elevated, passkey, cv_root, django_capture_on_commit_callbacks
):
    version = uploaded(elevated)
    action = request_delete(elevated, version)
    assert action.status_code == 201
    assert CvVersion.objects.count() == 1

    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    # The file goes once the deletion is committed.
    with django_capture_on_commit_callbacks(execute=True):
        response = elevated.post(f"/vital-actions/{action.json()['id']}/execute")

    assert response.status_code == 200
    assert CvVersion.objects.count() == 0
    assert stored_files(cv_root) == []
    assert AuditLog.objects.get(event="cv_version_deleted").detail == {
        "version": version
    }


def test_the_live_version_cannot_be_deleted(elevated):
    version = uploaded(elevated)
    elevated.post(f"{URL}/{version}/live")

    response = request_delete(elevated, version)

    assert response.status_code == 400
    assert PendingAction.objects.count() == 0


def test_a_version_made_live_during_the_wait_is_kept(elevated, passkey, cv_root):
    version = uploaded(elevated)
    action = request_delete(elevated, version).json()["id"]
    elevated.post(f"{URL}/{version}/live")

    mature(PendingAction.objects.get(), hours=24, seconds=1)
    reconfirm(elevated, passkey)
    response = elevated.post(f"/vital-actions/{action}/execute")

    assert response.status_code == 409
    assert CvVersion.objects.count() == 1
    assert len(stored_files(cv_root)) == 1


def test_a_pending_delete_shows_no_storage_key(elevated):
    version = uploaded(elevated)
    request_delete(elevated, version)

    body = elevated.get("/vital-actions").content.decode()

    assert CvVersion.objects.get().storage_key not in body
