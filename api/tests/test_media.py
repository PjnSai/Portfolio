"""Media library: what an upload must pass, what is kept, and who can see it."""

import io
import re
from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone
from PIL import ExifTags, Image

from core import storage
from core.models import Media
from tests.conftest import ADMIN

pytestmark = pytest.mark.django_db

NAME = re.compile(r"[0-9a-f]{32}-[0-9]{2,4}\.webp")


@pytest.fixture(autouse=True)
def media_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_ROOT = tmp_path / "media"
    settings.MEDIA_MAX_BYTES = 300_000
    return settings.MEDIA_ROOT


def picture(size=(40, 30), kind="JPEG", exif=None, colour=(200, 80, 20)):
    buffer = io.BytesIO()
    image = Image.new("RGB", size, colour)
    options = {"exif": exif} if exif is not None else {}
    image.save(buffer, kind, **options)
    return buffer.getvalue()


def camera_exif(orientation=1):
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "SecretCam"
    exif[ExifTags.Base.Orientation] = orientation
    exif[ExifTags.IFD.GPSInfo] = {
        ExifTags.GPS.GPSLatitudeRef: "N",
        ExifTags.GPS.GPSLatitude: (51.0, 30.0, 26.0),
        ExifTags.GPS.GPSLongitudeRef: "W",
        ExifTags.GPS.GPSLongitude: (0.0, 7.0, 39.0),
    }
    return exif


def upload(api, data, alt="A desk with a laptop", name="photo.jpg", extra=None):
    if api.csrf is None:
        api.fetch_csrf()
    body = {"file": _named(data, name), **({"alt": alt} if alt is not None else {})}
    body.update(extra or {})
    return api.client.post(ADMIN + "/media", body, secure=True, headers=api.headers())


def _named(data, name):
    handle = io.BytesIO(data)
    handle.name = name
    return handle


def stored_files(root):
    return sorted(path.name for path in root.rglob("*") if path.is_file())


def test_a_photo_is_re_encoded_into_responsive_webp_sizes(signed_in, media_root):
    response = upload(signed_in, picture(size=(2000, 1000)))

    assert response.status_code == 201, response.content
    item = response.json()
    assert item["alt"] == "A desk with a laptop"
    assert (item["width"], item["height"]) == (1600, 800)
    assert [v["width"] for v in item["variants"]] == [480, 960, 1600]
    for variant in item["variants"]:
        assert NAME.fullmatch(variant["name"])
        with Image.open(media_root / variant["name"]) as kept:
            assert kept.format == "WEBP"
            assert kept.width == variant["width"]


def test_a_small_image_is_never_scaled_up(signed_in):
    item = upload(signed_in, picture(size=(300, 200), kind="PNG")).json()

    assert [(v["width"], v["height"]) for v in item["variants"]] == [(300, 200)]


def test_exif_and_gps_are_removed(signed_in, media_root):
    original = picture(size=(600, 400), exif=camera_exif())
    with Image.open(io.BytesIO(original)) as check:
        assert check.getexif().get_ifd(ExifTags.IFD.GPSInfo)

    item = upload(signed_in, original).json()

    for variant in item["variants"]:
        raw = (media_root / variant["name"]).read_bytes()
        assert b"SecretCam" not in raw
        assert b"Exif" not in raw
        with Image.open(io.BytesIO(raw)) as kept:
            assert not kept.getexif()
            assert "exif" not in kept.info and "xmp" not in kept.info


def test_camera_rotation_is_applied_before_the_tag_is_dropped(signed_in):
    item = upload(signed_in, picture(size=(60, 30), exif=camera_exif(6))).json()

    assert (item["width"], item["height"]) == (30, 60)


def test_file_names_are_random_and_ignore_the_upload_name(signed_in, media_root):
    first = upload(signed_in, picture(), name="../../etc/passwd.jpg").json()
    second = upload(signed_in, picture(), name="photo.jpg").json()

    names = [v["name"] for v in first["variants"] + second["variants"]]
    assert len(set(names)) == len(names)
    assert all(NAME.fullmatch(name) for name in names)
    assert all("passwd" not in name for name in stored_files(media_root))
    assert all(path.parent == media_root for path in media_root.rglob("*.webp"))


SCRIPT = b"<script>alert(document.cookie)</script>"
NOT_IMAGES = [
    pytest.param(SCRIPT, "photo.jpg", id="script renamed as jpg"),
    pytest.param(b"#!/bin/sh\nrm -rf /\n", "photo.png", id="shell script as png"),
    pytest.param(
        b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        "logo.svg",
        id="svg",
    ),
    pytest.param(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "cv.webp", id="pdf as webp"),
    pytest.param(b"\xff\xd8\xff\xe0" + SCRIPT, "fake.jpg", id="jpeg magic, no image"),
    pytest.param(b"GIF89a" + b"\x00" * 40, "anim.gif", id="gif"),
    pytest.param(b"", "empty.jpg", id="empty"),
]


@pytest.mark.parametrize("data,name", NOT_IMAGES)
def test_files_that_are_not_accepted_images_are_refused(
    signed_in, media_root, data, name
):
    response = upload(signed_in, data, name=name)

    assert response.status_code == 400
    assert "file" in response.json()["errors"]
    assert Media.objects.count() == 0
    assert stored_files(media_root) == []


def test_other_real_image_types_are_refused(signed_in):
    response = upload(signed_in, picture(kind="BMP"), name="photo.jpg")

    assert response.status_code == 400


def test_the_declared_content_type_is_not_trusted(signed_in):
    if signed_in.csrf is None:
        signed_in.fetch_csrf()
    from django.core.files.uploadedfile import SimpleUploadedFile

    fake = SimpleUploadedFile("photo.jpg", SCRIPT, content_type="image/jpeg")
    response = signed_in.client.post(
        ADMIN + "/media",
        {"file": fake, "alt": "x"},
        secure=True,
        headers=signed_in.headers(),
    )

    assert response.status_code == 400


def test_an_oversize_file_is_refused(signed_in, settings, media_root):
    data = picture() + b"\x00" * settings.MEDIA_MAX_BYTES

    response = upload(signed_in, data)

    assert response.status_code == 413
    assert Media.objects.count() == 0
    assert stored_files(media_root) == []


def test_an_oversize_body_is_refused_before_it_is_read(signed_in, settings):
    signed_in.fetch_csrf()
    response = signed_in.client.post(
        ADMIN + "/media",
        b"x" * 10,
        content_type="multipart/form-data; boundary=x",
        secure=True,
        headers=signed_in.headers(),
        CONTENT_LENGTH=str(settings.MEDIA_MAX_BYTES * 2),
    )

    assert response.status_code == 413


def test_other_admin_routes_keep_the_small_body_limit(signed_in):
    response = signed_in.post("/sections", {"type": "text", "title": "x" * 1_100_000})

    assert response.status_code == 413


def test_too_many_pixels_is_refused(signed_in, settings):
    settings.MEDIA_MAX_PIXELS = 1000

    response = upload(signed_in, picture(size=(50, 50), kind="PNG"))

    assert response.status_code == 400


def test_alt_text_is_required(signed_in, media_root):
    for alt in (None, "", "   "):
        response = upload(signed_in, picture(), alt=alt)

        assert response.status_code == 400
        assert "alt" in response.json()["errors"]
    assert Media.objects.count() == 0
    assert stored_files(media_root) == []


def test_alt_text_is_one_line_of_at_most_300_characters(signed_in):
    assert upload(signed_in, picture(), alt="a\nb").status_code == 400
    assert upload(signed_in, picture(), alt="a" * 301).status_code == 400
    assert upload(signed_in, picture(), alt="a" * 300).status_code == 201


def test_unknown_form_fields_are_refused(signed_in):
    response = upload(signed_in, picture(), extra={"storage_key": "../../x"})

    assert response.status_code == 400
    assert Media.objects.count() == 0


def test_two_files_in_one_upload_are_refused(signed_in):
    response = upload(signed_in, picture(), extra={"file2": _named(picture(), "b")})

    assert response.status_code == 400
    assert Media.objects.count() == 0


def test_uploads_need_a_form_body(signed_in):
    response = signed_in.post("/media", {"alt": "x"})

    assert response.status_code == 400


def test_uploads_have_a_daily_cap(signed_in, settings):
    settings.MEDIA_DAILY_UPLOADS = 2

    codes = [upload(signed_in, picture()).status_code for _ in range(3)]

    assert codes == [201, 201, 429]


def test_storage_failure_fails_closed(signed_in, monkeypatch, media_root):
    def broken(self, name, data, content_type):
        raise OSError("disk full")

    monkeypatch.setattr(storage.LocalStorage, "save", broken)

    response = upload(signed_in, picture())

    assert response.status_code == 503
    assert Media.objects.count() == 0


# Library listing and editing


def test_the_library_is_paginated(signed_in):
    for _ in range(26):
        Media.objects.create(
            storage_key=storage.new_key(),
            content_type="image/webp",
            size=1,
            sha256="0" * 64,
            alt="a",
        )

    first = signed_in.get("/media").json()
    second = signed_in.get("/media", {"page": "2"}).json()

    assert (first["count"], first["pages"], len(first["results"])) == (26, 2, 25)
    assert len(second["results"]) == 1
    assert signed_in.get("/media", {"page": "0"}).status_code == 400
    assert signed_in.get("/media", {"sort": "x"}).status_code == 400


def test_alt_text_can_be_changed_and_is_still_required(signed_in):
    item = upload(signed_in, picture()).json()

    changed = signed_in.patch(f"/media/{item['id']}", {"alt": "New words"})
    empty = signed_in.patch(f"/media/{item['id']}", {"alt": ""})
    sneaky = signed_in.patch(f"/media/{item['id']}", {"storage_key": "x"})

    assert changed.status_code == 200 and changed.json()["alt"] == "New words"
    assert empty.status_code == 400
    assert sneaky.status_code == 400


def test_trash_and_restore(signed_in):
    item = upload(signed_in, picture()).json()

    assert signed_in.post(f"/media/{item['id']}/trash").status_code == 200
    assert signed_in.get("/media").json()["count"] == 0
    trash = signed_in.get("/trash").json()["results"]
    assert [(e["entity"], e["id"]) for e in trash] == [("media", item["id"])]
    assert signed_in.post(f"/media/{item['id']}/restore").status_code == 200
    assert signed_in.get("/media").json()["count"] == 1


def test_media_in_the_trash_is_deleted_with_its_files_after_30_days(
    signed_in, media_root
):
    from core import content

    item = upload(signed_in, picture()).json()
    Media.objects.filter(id=item["id"]).update(
        trashed_at=timezone.now() - timedelta(days=31)
    )

    content.purge_trash()

    assert not Media.objects.filter(id=item["id"]).exists()
    assert stored_files(media_root) == []


def test_the_admin_can_see_an_unpublished_image(signed_in):
    item = upload(signed_in, picture()).json()

    response = signed_in.get(f"/media/{item['id']}/file")

    assert response.status_code == 200
    assert response["Content-Type"] == "image/webp"
    assert response["Cache-Control"] == "no-store"
    assert response.content[:4] == b"RIFF"


# Public files


def public(path):
    return Client().get(path, secure=True)


def publish_project_with(api, media_id, visible=True):
    section = api.post("/sections", {"type": "projects", "title": "Work"}).json()["id"]
    api.post(
        f"/sections/{section}/items",
        {"data": {"title": "Ledger", "images": [{"media": media_id, "alt": "A"}]}},
    )
    if not visible:
        api.post(f"/sections/{section}/visibility", {"visible": False})
    api.post(f"/sections/{section}/publish", {})
    return section


def test_unpublished_images_are_not_public(signed_in):
    item = upload(signed_in, picture()).json()

    response = public(f"/api/v1/media/{item['variants'][0]['name']}")

    assert response.status_code == 404


def test_published_images_are_public_and_cached_for_good(signed_in):
    item = upload(signed_in, picture()).json()
    publish_project_with(signed_in, item["id"])

    response = public(f"/api/v1/media/{item['variants'][0]['name']}")

    assert response.status_code == 200
    assert response["Content-Type"] == "image/webp"
    assert "immutable" in response["Cache-Control"]
    assert response["X-Content-Type-Options"] == "nosniff"


def test_images_in_a_hidden_section_are_not_public(signed_in):
    item = upload(signed_in, picture()).json()
    publish_project_with(signed_in, item["id"], visible=False)

    response = public(f"/api/v1/media/{item['variants'][0]['name']}")

    assert response.status_code == 404


def test_trashed_images_stop_being_public_at_once(signed_in):
    item = upload(signed_in, picture()).json()
    publish_project_with(signed_in, item["id"])
    signed_in.post(f"/media/{item['id']}/trash")

    response = public(f"/api/v1/media/{item['variants'][0]['name']}")

    assert response.status_code == 404


TRAVERSAL = [
    "..%2F..%2Fconfig%2Fsettings.py",
    "%2e%2e%2f%2e%2e%2fmanage.py",
    "..%5C..%5Cmanage.py",
    "%2Fetc%2Fpasswd",
    "C:%5Cwindows%5Cwin.ini",
    "....%2F%2Fmanage.py",
    "0123456789abcdef0123456789abcdef-480.webp%00.py",
    "0123456789abcdef0123456789abcdef-480.webp%2F..%2F..%2Fmanage.py",
    "0123456789ABCDEF0123456789ABCDEF-480.webp",
    "0123456789abcdef0123456789abcdef-480.png",
]


@pytest.mark.parametrize("name", TRAVERSAL)
def test_path_traversal_on_the_public_file_route(signed_in, name):
    item = upload(signed_in, picture()).json()
    publish_project_with(signed_in, item["id"])

    response = public(f"/api/v1/media/{name}")

    assert response.status_code == 404


@pytest.mark.parametrize(
    "key",
    ["../x.webp", "..\\x.webp", "/etc/passwd", "a/b.webp", "", "x" * 300, "C:\\x"],
)
def test_storage_refuses_keys_outside_the_pattern(media_root, key):
    backend = storage.LocalStorage(media_root)

    with pytest.raises(storage.BadKey):
        backend.save(key, b"x", "image/webp")
    with pytest.raises(storage.BadKey):
        backend.read(key)
    with pytest.raises(storage.BadKey):
        backend.delete(key)


def test_public_site_lists_published_content_with_image_sources(signed_in):
    item = upload(signed_in, picture(size=(1000, 500))).json()
    publish_project_with(signed_in, item["id"])

    response = public("/api/v1/site")

    assert response.status_code == 200
    assert "public" in response["Cache-Control"]
    body = response.json()
    project = body["sections"][0]["items"][0]["data"]
    assert project["images"][0]["media"] == item["id"]
    sources = body["media"][item["id"]]["sources"]
    assert [s["width"] for s in sources] == [480, 960, 1000]
    assert all(s["url"].startswith("/api/v1/media/") for s in sources)
