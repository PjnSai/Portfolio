# Security notes

How the admin area is protected, how to operate it, and what is still open. Written after phase 1. The reasons behind each choice are in `DECISIONS.md`; the tests are listed in `OWASP-MAP.md`.

## What stands between the internet and an admin change

In order, for every request under `/api/v1/admin/`:

1. **Same-site check.** The admin pages are static files on Cloudflare Pages and call the API on another host of the same domain. A state-changing request must carry the site's exact `Origin` and `Sec-Fetch-Site` of `same-origin` or `same-site`. Admin reads with any other `Origin`, or from another site, are refused. CORS headers are sent to that one origin only, and only under `/api/v1/admin/`; a preflight from anywhere else is refused.
2. **Cloudflare Access.** The request must carry a token Cloudflare signed for this application and for the owner's email. The API verifies it itself on every request and compares the email exactly: no case folding, no trimming.
3. **Request cap.** 120 admin requests per client per minute.
4. **Declared level.** The route must have one of three levels; a route without one is refused.
   - *Access*: the sign-in, bootstrap and recovery routes only.
   - *Session*: signed in with a passkey.
   - *Elevated*: passkey confirmed again within the last five minutes.
5. **CSRF token** on every state-changing session route, sent as `X-CSRF-Token`. The client gets it from the sign-in response or `GET /session`, and must fetch it again after confirming with a passkey, because the session token changes.

If the database or Redis is down, steps 2 to 5 cannot be trusted, so every admin request gets the same plain 503. Public routes are not affected.

## One owner

- There is exactly one admin account: the single row in `admin_owner`, made by a migration. The database refuses a second row (unique flag plus a check constraint), and the app login can only read it and change two columns (`bootstrapped_at`, `recovery_key_hash`); it cannot insert or delete. No route creates an account.
- The row holds no personal data and no secret, only the SHA-256 of the recovery key.
- Every session references the owner row; the database refuses a session without it.

## Sessions

- Cookie `__Host-session`: `Secure`, `HttpOnly`, `SameSite=Strict`, no expiry date (it goes when the browser closes).
- 15 minutes idle, 8 hours in total. Confirming with a passkey does not extend the 8 hours.
- A new token at sign-in and at every passkey confirmation. A token supplied by the browser is never adopted.
- `POST /sessions/revoke-all` (elevated) ends every session at once and sends `sessions_revoked`.
- `POST /access/revoke-all` (elevated, no delay) removes every passkey, ends every session and cancels every pending vital action, then sends `access_revoked`. Both go ahead even if the notice cannot be sent, because they only take access away. Afterwards only the recovery key gets back in.
- `GET /passkeys` lists passkeys by id, name and dates; no key material.

## Sign-in limits

- Five failures from one client in 15 minutes start a 15-minute cool-down for that client. During it even the right passkey is refused.
- Twenty failures from all clients together start a global cool-down. It closes bootstrap and answers every failed sign-in with 429. **A valid passkey still signs in**, so a flood of failures cannot lock the owner out.
- Each cool-down is written to the audit log and sent to the notifier as `lockout`.
- Cool-downs always end by themselves. To clear one early, delete its row from `rate_limit_blocks`.

## Vital actions

Adding a passkey, revoking a passkey (`revoke_passkey`, payload `{"id": ...}`) and permanent deletion (projects and messages so far).

1. `POST /vital-actions/request` with a fresh passkey confirmation. The owner is notified, with the path that cancels it.
2. Wait 24 hours. The pending action shows in `GET /vital-actions` and as a count in `GET /session`, for the admin banner.
3. `POST /vital-actions/<id>/execute` with another fresh confirmation, within seven days. For a new passkey, call `/passkey-options` first and send the new credential with the run.

`POST /vital-actions/<id>/cancel` needs only a session and works at any point before the run.

A stolen session can therefore neither start nor finish a vital action, and a stolen session plus a stolen passkey confirmation still gives the owner 24 hours' notice.

## Audit log

- `GET /audit` lists entries newest first (`limit`, `before`, `event`). `GET /audit/verify` walks the whole chain and reports the first entry that does not fit.
- Entries never hold addresses, tokens, cookies or the owner's email.
- The database refuses update, delete and truncate on the table for every login. Only the table owner can switch that off, and the chain then shows the edit.

## Web pages

The site is a static export. After each build `web/scripts/write-headers.ts` writes `out/_headers`, which Cloudflare Pages applies: HSTS, `nosniff`, frame denial and the other headers in `web/lib/security-headers.ts`, and for each page a Content-Security-Policy listing the SHA-256 hashes of that page's own inline scripts. Inline scripts and event handlers not in the list do not run. Only the admin pages may connect to the API. Do not add `'unsafe-inline'`, and do not add a third-party script host without a decision recorded in `DECISIONS.md`. A script written by hand goes in `EXTRA_SCRIPT_HASHES`.

The Pages deploy hook URL (`PAGES_DEPLOY_HOOK_URL`) lets anyone holding it start builds. It lives in the API's secret store, must point at Cloudflare's deploy hook path, and is never logged, stored, audited or returned. Builds are asked for at most once per two minutes.

## Operating

**Environment.** Names are in `.env.example`; values live in the secret store, never in the repository.

**First passkey.** Generate a long random token, put its SHA-256 (hex) in `BOOTSTRAP_TOKEN_SHA256`, and enrol the passkey through the bootstrap routes. The response holds the recovery key, shown this once: store it offline. Bootstrap then closes for good (`admin_owner.bootstrapped_at` is set under a row lock), even if every passkey is later removed. Clear the variable afterwards anyway.

**Notifier.** `NOTIFIERS` defaults to `core.notify.LogNotifier` in Compose and `.env.example`. With none set, vital actions and recovery are refused.

**Database logins.** Run `api/db/roles.sql` once and `api/db/grants.sql` after every migration that adds a table. The running API connects as a member of `app_rw`; migrations run as a member of `migrator`.

**Lost passkey.** There is no reset link by design. Behind Cloudflare Access, `POST /recovery/options` with `{"key"}` and then `POST /recovery/verify` with `{"key", "name", "credential"}` enrol a new passkey and remove every other one, end every session and cancel pending vital actions. The key works once; the response holds its replacement. Wrong keys count as failed sign-ins and hit the same cool-down. Recovery is refused (503) if the `recovery_used` notice cannot be sent. Enrol a second passkey early so this is rarely needed.

**Keys.** Changing `DJANGO_SECRET_KEY` ends all CSRF tokens and rate-limit keys (harmless). Changing `AUDIT_CHAIN_KEY` makes the existing chain fail verification; do not change it without archiving the log first.

## Open items

| Item | Risk while open | Planned |
|------|-----------------|---------|
| Only `LogNotifier` exists; no email notice yet. | The 24-hour notice depends on someone watching the log or the admin banner. | Phase 5 |
| The newest audit entries could be removed without breaking the chain. | Someone with table-owner rights could hide their latest actions. | Phase 7 (anchor kept with backups) |
| Client address comes from `Cf-Connecting-Ip`, which is only trustworthy if traffic cannot bypass Cloudflare. | Without the origin lock, a caller holding a valid Access token could spread failures across made-up addresses. The global cool-down still applies. | Phase 7 (origin lock) |
| `_headers` rules (detaching the default policy per page) are checked against a local server that follows the Pages rules, not against Pages itself. | A page could get two policies, which would block its scripts (fails closed). | Phase 7 (smoke test of live headers) |
| Permanent delete does not cover media or CV files. | None; they simply cannot be permanently deleted yet. | Phases 2, 4 |
| Base images pinned by tag, not digest. | A re-tagged image would be picked up. | Phase 6 |
