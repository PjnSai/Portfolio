"""Image uploads. The bytes decide what a file is, never its name or the type
the browser declared. Every accepted image is decoded and drawn again as WebP
from its pixels alone, so EXIF, GPS, XMP, comments and anything hidden after
the image data are left behind. Only the re-encoded sizes are kept.
"""

import hashlib
import io
import time

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from PIL import Image, ImageOps, UnidentifiedImageError

from core import audit, cache, storage
from core.models import Media

ACCEPTED = ("JPEG", "PNG", "WEBP")
WIDTHS = (480, 960, 1600)
QUALITY = 82
NOT_AN_IMAGE = "Choose a JPEG, PNG or WebP image."
TOO_BIG = "That image has too many pixels. Use one under 40 megapixels."


class Rejected(ValueError):
    pass


class TooLarge(ValueError):
    pass


class OverCap(Exception):
    pass


def _decode(data):
    if len(data) > settings.MEDIA_MAX_BYTES:
        raise TooLarge
    try:
        with Image.open(io.BytesIO(data), formats=ACCEPTED) as image:
            if image.width * image.height > settings.MEDIA_MAX_PIXELS:
                raise Rejected(TOO_BIG)
            image.seek(0)  # First frame only of an animated PNG or WebP.
            image.load()
            upright = ImageOps.exif_transpose(image)
    except Rejected:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as error:
        raise Rejected(NOT_AN_IMAGE) from error
    except (SyntaxError, ValueError, EOFError) as error:
        raise Rejected(NOT_AN_IMAGE) from error
    mode = "RGBA" if upright.mode in ("RGBA", "LA", "PA") else "RGB"
    if upright.mode == "P" and "transparency" in upright.info:
        mode = "RGBA"
    pixels = upright.convert(mode)
    # A new image from the pixels alone carries no metadata over.
    return Image.frombytes(mode, pixels.size, pixels.tobytes())


def _widths(width):
    sizes = [w for w in WIDTHS if w < width]
    sizes.append(min(width, WIDTHS[-1]))
    return sorted(set(sizes))


def sizes(data):
    """[(width, height, webp bytes)] smallest first. Raises Rejected or TooLarge."""
    clean = _decode(data)
    out = []
    for width in _widths(clean.width):
        height = max(1, round(clean.height * width / clean.width))
        scaled = (
            clean
            if width == clean.width
            else clean.resize((width, height), Image.Resampling.LANCZOS)
        )
        buffer = io.BytesIO()
        scaled.save(buffer, "WEBP", quality=QUALITY, method=4)
        out.append((width, height, buffer.getvalue()))
    return out


def count_upload():
    """Count one upload against today's cap; raises OverCap once it is used up."""
    day = int(time.time() // 86400)
    client = cache.client()
    name = f"uploads:{day}"
    client.set(name, 0, ex=86400, nx=True)
    if client.incr(name) > settings.MEDIA_DAILY_UPLOADS:
        raise OverCap


def add(data, alt):
    """Store an image under new random names and record it. Fails closed: if
    any size cannot be stored, the ones already stored are removed again."""
    variants = sizes(data)
    base = storage.new_key()
    store = storage.backend()
    saved = []
    try:
        for width, height, body in variants:
            key = storage.variant_key(base, width)
            store.save(key, body, "image/webp")
            saved.append(
                {"name": key, "width": width, "height": height, "size": len(body)}
            )
        with transaction.atomic():
            width, height, largest = variants[-1]
            item = Media.objects.create(
                storage_key=base,
                content_type="image/webp",
                size=len(largest),
                sha256=hashlib.sha256(largest).hexdigest(),
                width=width,
                height=height,
                alt=alt,
                variants=saved,
            )
            audit.record("media_added", media=str(item.id))
    except Exception:
        for entry in saved:
            try:
                store.delete(entry["name"])
            except Exception:  # noqa: S110 - the first error is the one to report.
                pass
        raise
    return item


def delete_files(item):
    store = storage.backend()
    for entry in item.variants:
        store.delete(entry["name"])


def live():
    return Media.objects.filter(trashed_at=None).order_by("-created_at")


def set_alt(item, alt):
    item.alt = alt
    item.save(update_fields=["alt"])
    audit.record("media_changed", media=str(item.id))


def trash(item):
    item.trashed_at = timezone.now()
    item.save(update_fields=["trashed_at"])
    audit.record("media_trashed", media=str(item.id))


def find_variant(name):
    """The live media row holding a size with this file name, or None."""
    if not isinstance(name, str) or not storage.KEY.fullmatch(name):
        return None
    base = name.split("-", 1)[0]
    item = Media.objects.filter(storage_key=base, trashed_at=None).first()
    if item is None or not any(v["name"] == name for v in item.variants):
        return None
    return item


def sources(item):
    return [
        {
            "width": v["width"],
            "height": v["height"],
            "url": f"/api/v1/media/{v['name']}",
        }
        for v in item.variants
    ]
