# Decisions

Short record of choices made while building, with the reason. Newest last.

## Phase 0

- **Django 5.2 (LTS) on Python 3.12.** The spec asks for the current LTS release. Python 3.12 matches the local toolchain and is supported by 5.2.
- **Python dependencies pinned with hashes** (`pip-compile --generate-hashes`; edit `requirements*.in`, then recompile). An altered package fails the install rather than being used.
- **No database URL library.** `DATABASE_URL` is parsed with the standard library in `config/settings.py`; one dependency fewer.
- **Redis client not installed yet.** Nothing uses it until rate limiting arrives in phase 1.
- **API denies by default.** The default DRF permission is `IsAuthenticated`; public endpoints opt in with `AllowAny`. JSON renderer and parser only, so there is no browsable API.
- **No default secret key.** The API refuses to start without `DJANGO_SECRET_KEY`. Tests set their own in `tests/settings.py`.
- **Web image is distroless** (non-root, no shell). **API image is `python:3.12-slim`** running as a numeric non-root user on a read-only filesystem. It still contains a shell; moving it to a shell-less base is left for the hardening phase.
- **Gunicorn control socket disabled.** It is not needed and would require a writable home directory.
- **Base images are pinned by tag for now.** Pinning by digest is left for the hardening phase; Dependabot watches them meanwhile.
- **No web fonts or placeholder styling.** Design work starts in phase 3.
- **End-to-end tests run against the standalone build**, the same server the container runs.
- **`/healthz` on Cloud Run.** The Google front end may intercept some paths ending in `z` on `*.run.app` URLs. To be confirmed in phase 7 before health checks rely on it from outside.
