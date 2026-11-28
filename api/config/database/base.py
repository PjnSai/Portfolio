"""PostgreSQL that tries a failed connection once more.

Neon's free plan stops a database after five idle minutes, and the connection
that wakes it can fail. A second failure is raised as usual, so the admin and
the forms answer 503 (core.guard, the form views) and nothing is retried again.
"""

import logging

from django.db.backends.postgresql import base

log = logging.getLogger(__name__)


class DatabaseWrapper(base.DatabaseWrapper):
    def get_new_connection(self, conn_params):
        try:
            return super().get_new_connection(conn_params)
        except base.Database.OperationalError:
            log.warning("database connection failed, trying once more")
            return super().get_new_connection(conn_params)
