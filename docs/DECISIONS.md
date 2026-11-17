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

## Phase 1

- **No Django auth, sessions or admin apps.** Passkeys and sessions live in `core`, so there is no password table and no code path that could accept one.
- **Cloudflare Access is checked by the API itself**, on every admin request and before the URL is resolved. The API does not trust that a request came through Cloudflare; it verifies the signed token (RS256 only, audience, issuer, owner email). Unknown admin paths therefore look the same as known ones.
- **One place decides admin authorisation.** Every admin view is wrapped with `admin_route(level)`; the guard refuses any admin URL without a declared level, so a new route is denied until someone chooses its level.
- **CSRF: three independent checks.** State-changing requests need an exact `Origin`, `Sec-Fetch-Site: same-origin`, and a token derived from the session with HMAC. The token changes whenever the session token does, so nothing extra is stored.
- **The six sign-in routes have no CSRF token** (login, bootstrap and recovery, options and verify each). They run before a session exists, so there is nothing to derive one from. They rely on the Origin and Fetch-Metadata checks, the Access token and `SameSite=Strict`. `test_csrf.py` lists them by name and fails if another route appears without a token.
- **Session token is random, stored as SHA-256.** A plain hash is enough because the token is 256 random bits; there is nothing to brute-force.
- **Passkey confirmation lasts five minutes** and issues a new session token. It is not consumed by one action, so several vital actions can be requested in one sitting.
- **Sign-in failures are indistinguishable.** No credential list is sent, and an unknown passkey is still verified against a throwaway key so the work is the same.
- **Rate-limit counters in Redis, cool-downs in Postgres.** A cool-down must survive a Redis restart; a counter need not. Addresses are stored only as a keyed hash.
- **The global cool-down never blocks a valid passkey.** Failures from many addresses start it. It closes bootstrap and turns every failed sign-in into a 429, but `login/options` stays open and a correct passkey signs in. Otherwise anyone able to reach the sign-in route could lock the owner out for as long as they kept failing. During it all failures get the same 429 after the same signature check, so it reveals nothing about which passkeys exist. A client's own cool-down still refuses even the right passkey, and still ends after 15 minutes.
- **The 503 for a missing dependency is admin only.** The guard uses neither the database nor Redis for a public request and does not convert errors raised by public views. Public reads get their own fail-static handling in phase 3.
- **Vital actions: fixed 24-hour wait, then a 7-day window.** The delay is a constant on the server; fields the client sends for it are ignored. An action not run within seven days of maturing expires. Cancelling needs only a session, so a cancel is always easier than a run.
- **A vital action is refused if the owner cannot be told.** This includes the case where no notifier is configured. The request, its audit entry and the notice succeed or fail together. A new passkey is likewise undone if its notice fails.
- **Notifiers are chosen by the `NOTIFIERS` setting** (comma-separated dotted paths). `core.notify.LogNotifier` writes notices to the log and is the only one shipped so far; an email notifier arrives in phase 5. Until then the notice is only as out-of-band as the log alerts are.
- **Permanent delete covers projects and messages only**, by allow-list. Media and CV files join when their stored objects can be removed with them (phases 2 and 4). Auth and audit tables can never be named.
- **Adding a passkey is two steps after the wait**: options, then run with the new credential. A failed registration leaves the action ready to try again.
- **Audit listing is paged by sequence number**, newest first, at most 100 per page. Unknown or repeated query parameters are refused rather than ignored.
- **Audit chain limit.** Removing the newest entries leaves a shorter chain that still verifies. Catching that needs the latest sequence number and hash kept somewhere else; planned with backups in phase 7.
- **Web CSP uses a per-request nonce**, set in `web/proxy.ts` (the Next.js 16 name for middleware) with no matcher, so every response carries the headers. Next.js reads the nonce from the request and adds it to its own tags. The cost: every page is rendered per request (`connection()` in the root layout), so pages cannot be cached at the edge as they are. To be revisited in phase 3, when public pages need caching; hash-based CSP is the likely answer.
- **No `upgrade-insecure-requests` in the CSP.** HSTS does that job, and the directive would break tests against the local HTTP server.
- **`npm run typecheck` runs `next typegen` first.** The layout uses a generated type, and CI type-checks before it builds.
- **CI runs Postgres and Redis as job services**, the same major versions as Docker Compose. Their password is a fixed throwaway value: the services exist for one job and hold no real data. The database role tests need a superuser to create roles.
- **One owner row, enforced by the database.** `admin_owner` holds a single row made by a migration: a unique boolean that a check constraint pins to true. The app login has SELECT and column-level UPDATE only, so a bug or injection in the app cannot add an account. Sessions carry a foreign key to it.
- **Bootstrap closes for good**, recorded in `admin_owner.bootstrapped_at` under a row lock, not inferred from whether a passkey exists. Removing every passkey must not reopen it.
- **Access email is compared exactly.** Cloudflare sends the address the policy matched; folding case or trimming would only widen what is accepted.
- **Recovery key instead of a database reset.** 256 random bits, shown once at bootstrap, stored as SHA-256 (enough for a random key), single use and replaced on use. It is the only way back after `access/revoke-all` or losing every passkey, so it needs Access, counts towards the sign-in cool-down and is refused if the owner cannot be told. A password-style reset link was rejected: it would add a second way in that needs no passkey.
- **Revoking sessions or all access runs at once, and a failed notice does not stop it.** These only take access away, so delaying them or making them depend on the notifier would help an attacker, not the owner. Both need a fresh passkey confirmation so a stolen session cannot lock the owner out. Revoking a single passkey goes through the 24-hour vital action instead, because a stolen session plus confirmation could otherwise remove the owner's other keys quietly.
- **`NOTIFIERS` defaults to `core.notify.LogNotifier`** in Compose and `.env.example`, so a fresh setup does not refuse every vital action. The settings default stays empty: production must name its notifiers.
- **Ruff rules S106 and S107 are off for tests.** They flag the fixed bootstrap token the tests use on purpose.
