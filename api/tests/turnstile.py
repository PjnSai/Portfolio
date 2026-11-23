"""A stand-in for Cloudflare's check. Never used in production.

It behaves as Cloudflare does with its published dummy keys: a dummy token
passes once (tests add a suffix to make each one different); a spent token, or
any other, fails. A token named "unavailable"
stands for Cloudflare not answering.
"""

from core.turnstile import Unavailable

PASSES = "XXXX.DUMMY.TOKEN.XXXX"
spent = set()
asked = []


class FakeVerifier:
    def verify(self, response):
        asked.append(response)
        if response == "unavailable":
            raise Unavailable("fake outage")
        if not response.startswith(PASSES):
            return False
        if response in spent:
            return False
        spent.add(response)
        return True
