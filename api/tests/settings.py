import os

os.environ["DJANGO_SECRET_KEY"] = "test-only-key-not-used-anywhere-else"
os.environ["DJANGO_ALLOWED_HOSTS"] = "testserver"
os.environ.pop("DJANGO_DEBUG", None)

from config.settings import *  # noqa: E402, F403
