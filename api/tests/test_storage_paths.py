import os

import pytest

from core.storage import BadKey, LocalStorage

GOOD = "0123456789abcdef0123456789abcdef-320.webp"

BAD = [
    "../x",
    "..\\x",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "a\x00b",
    "%2e%2e%2fx",
    "",
    GOOD + "\n",
    GOOD + ".png",
    "../" + GOOD,
    GOOD + "/../x",
]


@pytest.mark.parametrize("key", BAD)
def test_bad_keys_refused_everywhere(tmp_path, key):
    store = LocalStorage(tmp_path)
    with pytest.raises(BadKey):
        store.read(key)
    with pytest.raises(BadKey):
        store.save(key, b"x", "image/webp")
    with pytest.raises(BadKey):
        store.delete(key)


def test_good_key_round_trip(tmp_path):
    store = LocalStorage(tmp_path)
    store.save(GOOD, b"data", "image/webp")
    assert store.read(GOOD) == b"data"
    store.delete(GOOD)
    assert not (tmp_path / GOOD).exists()


def test_symlink_pointing_outside_is_refused(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_bytes(b"secret")
    try:
        os.symlink(outside, root / GOOD)
    except OSError:
        pytest.skip("symlinks need extra privileges on this machine")
    store = LocalStorage(root)
    with pytest.raises(BadKey):
        store.read(GOOD)
    with pytest.raises(BadKey):
        store.delete(GOOD)
    assert outside.read_bytes() == b"secret"
