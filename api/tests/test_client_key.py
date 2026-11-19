"""The client key reads Cf-Connecting-Ip only when it holds a real address."""

import pytest
from django.test import RequestFactory

from core.ratelimit import client_address, client_key, keyed

REMOTE = "10.0.0.9"


def request_with(header=None):
    headers = {} if header is None else {"Cf-Connecting-Ip": header}
    return RequestFactory().get("/api/v1/site", headers=headers, REMOTE_ADDR=REMOTE)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("203.0.113.7", "203.0.113.7"),
        ("2001:db8::1", "2001:db8::1"),
        ("2001:DB8:0:0:0:0:0:1", "2001:db8::1"),
    ],
)
def test_valid_address_in_header_is_used(header, expected):
    request = request_with(header)

    assert client_address(request) == expected
    assert client_key(request) == keyed(f"ip:{expected}")


@pytest.mark.parametrize(
    "header", ["not-an-ip", "203.0.113.7, 198.51.100.1", "999.1.1.1", "", "a" * 500]
)
def test_invalid_header_falls_back_to_remote_addr(header):
    request = request_with(header)

    assert client_address(request) == REMOTE
    assert client_key(request) == keyed(f"ip:{REMOTE}")


def test_missing_header_falls_back_to_remote_addr():
    assert client_address(request_with()) == REMOTE


def test_random_strings_share_one_key():
    keys = {client_key(request_with(f"junk-{n}")) for n in range(5)}

    assert keys == {keyed(f"ip:{REMOTE}")}
