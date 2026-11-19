"""The public site document and images: cache headers, revalidation and the
per-client cap. Public reads fail static, so with Redis down they still answer."""

import pytest
from django.test import Client

SITE = "/api/v1/site"
MEDIA = "/api/v1/media/00000000000000000000000000000000-480.webp"


def cache_parts(response):
    return {part.strip() for part in response["Cache-Control"].split(",")}


@pytest.mark.django_db
def test_site_is_cached_briefly_at_the_edge_and_revalidated(client):
    response = client.get(SITE)

    assert response.status_code == 200
    parts = cache_parts(response)
    assert "public" in parts
    assert "max-age=60" in parts
    # Purge on publish is the fast path; if it fails the edge copy is at most
    # two minutes old, the same as the rebuild debounce.
    assert "s-maxage=120" in parts
    assert "stale-if-error=604800" in parts
    assert "no-store" not in parts


@pytest.mark.django_db
def test_site_has_an_etag_and_answers_304_when_unchanged(client):
    first = client.get(SITE)
    etag = first["ETag"]

    assert etag.startswith('"') and etag.endswith('"')
    again = client.get(SITE, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again["ETag"] == etag
    assert "s-maxage=120" in again["Cache-Control"]


@pytest.mark.django_db
def test_a_stale_etag_gets_the_full_document(client):
    response = client.get(SITE, headers={"If-None-Match": '"old"'})

    assert response.status_code == 200
    assert "sections" in response.json()


@pytest.mark.django_db
def test_the_etag_changes_when_the_published_site_changes(client):
    from core.models import SiteSettings

    before = client.get(SITE)["ETag"]
    SiteSettings.objects.create(draft={}, published={"title": "Changed"})

    assert client.get(SITE)["ETag"] != before


@pytest.mark.django_db
def test_admin_routes_stay_no_store(api):
    for path in ("/session", "/csrf", "/settings"):
        assert api.get(path)["Cache-Control"] == "no-store", path


@pytest.mark.django_db
@pytest.mark.parametrize("path", [SITE, MEDIA])
def test_public_reads_are_capped_per_client_with_retry_after(client, settings, path):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 3
    for _ in range(3):
        assert client.get(path).status_code in (200, 404)

    refused = client.get(path)

    assert refused.status_code == 429
    assert 1 <= int(refused["Retry-After"]) <= 60
    assert refused["Cache-Control"] == "no-store"
    assert refused.json() == {"detail": "Too many requests."}


@pytest.mark.django_db
def test_the_cap_is_per_client(client, settings):
    settings.PUBLIC_REQUESTS_PER_MINUTE = 1
    client.get(SITE, headers={"Cf-Connecting-Ip": "192.0.2.1"})

    other = Client().get(SITE, headers={"Cf-Connecting-Ip": "192.0.2.2"})

    assert other.status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize("url", ["redis://127.0.0.1:1/0", ""])
def test_public_reads_answer_when_redis_is_down(client, settings, url):
    settings.REDIS_URL = url
    settings.PUBLIC_REQUESTS_PER_MINUTE = 1

    for _ in range(3):
        assert client.get(SITE).status_code == 200
