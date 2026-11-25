# Threat model

Method: STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege). Reviewed at every phase and before each release.

Status key: **in place** (control and test exist), **planned** (phase named).

## Assets

Site content, the admin session and passkey, contact messages and CV requests, the public CV file, deploy credentials, the audit log, and the free-tier budget.

## Trust boundaries

Internet to Cloudflare; Cloudflare to Cloud Run (web, api); api to Postgres and Redis; api to email and captcha services; GitHub Actions to Google Cloud.

## Threats by surface

| # | Surface | Main threats (STRIDE) | Controls | Status |
|---|---------|-----------------------|----------|--------|
| 1 | Public pages (home, sections, project pages) | T: stored XSS through content. I: draft or hidden content shown. D: floods. | Output encoding, sanitised Markdown, strict CSP; only published content rendered; pages cached at the edge and readable without JavaScript. | Planned: phases 3, 6 |
| 2 | Public read API (`/api/v1`) | I: unpublished data, object ID guessing. D: database exhaustion. T: injection. | Deny by default, explicit public endpoints, random IDs, ORM only (raw SQL blocked in CI), rate limits, cached reads. | Deny by default and raw SQL check in place; rest phases 1 to 3 |
| 3 | Contact form | S: bots. T: email header injection, spam links. D: message and email floods. I: enumeration by response. | Turnstile and honeypot, schema validation, length caps, per-IP and daily caps, generic responses, fails closed if a dependency is down. | Planned: phase 4 |
| 4 | CV view and copy request (`/api/v1/cv`, `/cv/link`, `/cv/file/<token>`, `/cv/request`; admin `/admin/cv/...`) | I: the file reached by URL guessing or a shared link; keys, ids or hashes leaked; personal data in the view log. T: a PDF carrying scripts; path traversal through a storage key. S: bots fetching or requesting. D: bandwidth and inbox floods. E: switches or versions changed without the owner. | No lasting public file URL; 60-second signed links, one purpose each (view inline, download as an attachment), bound to the live version by a keyed hash (no id), one generic 404 for any bad link; download links only from a copy request that passed Turnstile and the contact limits, with the same answer for every sender; private store with its own key pattern; Turnstile, per-client hour limit and a site day cap on links; requests through the contact pipeline and its limits; view logged before the file is sent (503 if it cannot be); no address or email stored; upload checks with an active-content heuristic behind a fresh passkey; switches and deletes are vital actions; CORS for the site origin only, no credentials. | In place (phase 4C-1); viewer in phase 4C web |
| 5 | Images and media | T: script served as an image. I: EXIF location data. | Type sniffing and re-encoding, EXIF stripping, `nosniff`, separate storage origin. | Planned: phase 2 |
| 6 | Health and status (`/healthz`, `/api/v1/status`) | I: version or configuration leak. D: cheap request flood. | Fixed body with no version or dependency detail, never cached, covered by edge rate limit. | In place (edge limit: phase 7) |
| 7 | Admin sign-in | S: credential theft, session fixation. I: account enumeration. D: lock-out attack. | Passkey behind Cloudflare Access, server-side sessions with `__Host-` cookies, rotation on login, generic responses and equal timing, rate limit with cool-down. | Planned: phase 1 |
| 8 | Admin editing API | E: access without a valid session. T: CSRF, mass assignment, IDOR. R: unlogged change. | Session check on every route, CSRF token with Origin and Fetch-Metadata checks, explicit serializer fields, hash-chained audit log, fresh passkey and delay for vital actions. | Planned: phases 1, 2 |
| 9 | File upload (admin) | T: unsafe file type, oversized file, path traversal. D: storage exhaustion. | Allow-list of types, size cap, generated file names, daily cap, fails closed. | Planned: phase 2 |
| 10 | Database and cache | T/I: SQL injection, over-privileged login. D: free-tier compute used up. R: audit rows edited. | ORM only, separate runtime and migration logins, audit table insert-only for the runtime login, public reads served from cache. | Planned: phases 1, 7 |
| 11 | Origin and hosting | S: traffic that bypasses Cloudflare. I: verbose errors. E: container escape. | Origin lock, generic error pages, non-root read-only containers, instance cap of 2. | Containers in place; origin lock phase 7 |
| 12 | Build and deploy pipeline | T: malicious dependency or action, tampered image. E: stolen deploy key. | Lockfile and hash-pinned installs, actions pinned to commit hashes, audits, CodeQL, Dependabot, Workload Identity Federation (no stored keys), approval on a protected environment. | Pinning, audits, CodeQL, Dependabot in place; rest phases 6, 7 |
| 13 | Admin security pages (abuse overview, alerts, access review) | I: personal data or secrets shown. T/R: an alert dismissed to hide an attack. D: alert floods, counting used to slow the site. | Counts and fixed summaries only; secrets shown as set or not; rights read live from Postgres; dismissals audited; required notices need a notifier outside the site; once-per-window alerts with a daily cap; counting never raises. | In place (phase 5-1); admin pages in phase 5 web |

## CV abuse cases (phase 4C-1)

- A link passed to someone else works for at most 60 seconds, and stops at once when another version goes live or its switch is turned off (viewing for a view link; request or instant download for a download link). Getting links is limited per client and per day, or by the contact limits for download links; each fetch is logged with its kind.
- A view link cannot be used as a download link or the other way round: each is signed with its own salt.
- A link from another signing purpose, a changed or made-up token, or one naming an old version gets the same 404 as nonsense. The token carries a keyed hash, so it cannot be turned into a version id.
- A script hammering `/cv/link` without passing Turnstile spends only its own hourly allowance; the site's daily cap counts only visitors who passed.
- Turnstile, Redis or the database down: no link, no file, nothing stored (503).
- Header injection through the request's name or email is refused (one line only); the note is message text and never reaches a header. The site sends no email at all.
- A blocked sender is told "received" and nothing is stored, as on the contact form. With instant download on they get the same download link as anyone else, so the answer never shows they are blocked; the CV is public, so this gives them nothing new. The same holds for a request flagged as spam.
- An encrypted PDF, one with script or launch actions or attached files, a renamed non-PDF and a ZIP behind a PDF header are refused before anything is stored. The check is a heuristic; the only uploader is the owner behind a passkey.
- The view log holds no address, email or free text; the country is only a two-letter code, and the user agent is cleaned and cut. Raw rows go after 90 days; only day totals stay.

## Abuse counters, alerts and access review (phase 5-1)

Routes (all need a session behind Cloudflare Access): `GET /api/v1/admin/abuse`, `GET /api/v1/admin/alerts`, `POST /api/v1/admin/alerts/<id>/seen`, `GET /api/v1/admin/access`.

- I: personal data in counts, alerts or their logs. The counts table holds a day, a kind and a number; an alert holds a kind, fixed text and times. Summaries take only numbers and values from fixed lists. Tests send real addresses, emails, message text and passkey names through every trigger and check none of them appears.
- I: secrets on the access review. It shows whether a secret is set, never its value, and no session id, token, hash or key material. A test sets every secret and checks the answer.
- I: the access review drifting from reality. The database rights are read from Postgres for every table at request time; a test compares them with `information_schema` after `grants.sql`, and another changes a grant and checks the page follows. A superuser connection is shown as a warning.
- D: counting as a way to slow the site. A count is one UPDATE on one row and never raises; if it fails, the answer is unchanged. The edge limit comes before it.
- D: flooding the owner with alerts. Threshold alerts fire once per window, do not repeat inside it, and each kind is capped at 5 a day. Held-back threshold alerts go to no notifier.
- T/R: hiding an attack by dismissing its alert. Marking seen is audited, and the database notifier never counts as telling the owner: required notices still need a notifier outside the site (log now, email later).
- D: a notifier failure breaking an action. The database notifier is best effort in its own savepoint; a failure is logged and counted, and the action goes ahead.
- S/E: reaching these routes without the owner. The same `admin_route` guard as every admin route (deny by default, session on each request); none of them changes access. Revoking is only through the existing routes, which the page names.
- Not covered by the app: the scopes of the pipeline identity, the Cloudflare token and the deploy hook, the Access policy, and where the recovery key is kept. They are reviewed by hand each quarter (`docs/ACCESS.md`).

## Local development mode (phase L)

`api/devmode` stands in for Cloudflare Access on the owner's PC (docs/LOCAL-DEV.md).

- E/S: the stand-in gate reaching production. It is a separate launcher that production code never imports (checked by a test that parses `config/` and `core/`, and by one that imports `config.wsgi` in a fresh process). `.dockerignore` leaves it out of the image, and the Dockerfile copies only `config` and `core`. The real check is unchanged and refuses the dev token with the real key lookup, so the patch exists only inside a running launcher.
- E/S: the launcher run against production data. Before Django starts and again after, it refuses when the database name does not end in `_dev`, the database or Redis is not on loopback, the bind is not 127.0.0.1, or production values are present (Cloudflare purge token or zone, the Pages deploy hook, Cloud Storage buckets, a real Turnstile secret, a non-local site origin, Cloud Run's variables). Anything it cannot check is a refusal. The seed, reset and drop commands also refuse, on their own, a database not ending in `_dev`.
- S: someone on the local network using the stand-in gate. The server binds to 127.0.0.1 only, and the wrapper adds a token only for a loopback client and always drops one the client sent.
- I: real data in the dev database. The seed writes SAMPLE text only, checked by tests and the privacy scan; senders are at example.com.
- Residual risk: someone runs the launcher on a machine where a production database is reachable through a loopback tunnel, after renaming that database to end in `_dev`, with none of the production values in the environment. That takes deliberate work on a database that should not have that name. The live site's own Access policy, passkeys and least-privilege role are untouched, and the launcher never contacts the live site.

## Out of scope

Visitor accounts (there are none), and compromise of the GitHub, Cloudflare or Google Cloud accounts themselves beyond the separate-account and MFA measures in the design.
