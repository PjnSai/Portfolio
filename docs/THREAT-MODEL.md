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
| 4 | CV view and copy request (`/api/v1/cv`, `/cv/link`, `/cv/file/<token>`, `/cv/request`; admin `/admin/cv/...`) | I: the file reached by URL guessing or a shared link; keys, ids or hashes leaked; personal data in the view log. T: a PDF carrying scripts; path traversal through a storage key. S: bots fetching or requesting. D: bandwidth and inbox floods. E: switches or versions changed without the owner. | No public file URL or download route; a 60-second signed link bound to the live version by a keyed hash (no id), one generic 404 for any bad link; private store with its own key pattern; Turnstile, per-client hour limit and a site day cap on links; requests through the contact pipeline and its limits; view logged before the file is sent (503 if it cannot be); no address or email stored; upload checks with an active-content heuristic behind a fresh passkey; switches and deletes are vital actions; CORS for the site origin only, no credentials. | In place (phase 4C-1); viewer in phase 4C web |
| 5 | Images and media | T: script served as an image. I: EXIF location data. | Type sniffing and re-encoding, EXIF stripping, `nosniff`, separate storage origin. | Planned: phase 2 |
| 6 | Health and status (`/healthz`, `/api/v1/status`) | I: version or configuration leak. D: cheap request flood. | Fixed body with no version or dependency detail, never cached, covered by edge rate limit. | In place (edge limit: phase 7) |
| 7 | Admin sign-in | S: credential theft, session fixation. I: account enumeration. D: lock-out attack. | Passkey behind Cloudflare Access, server-side sessions with `__Host-` cookies, rotation on login, generic responses and equal timing, rate limit with cool-down. | Planned: phase 1 |
| 8 | Admin editing API | E: access without a valid session. T: CSRF, mass assignment, IDOR. R: unlogged change. | Session check on every route, CSRF token with Origin and Fetch-Metadata checks, explicit serializer fields, hash-chained audit log, fresh passkey and delay for vital actions. | Planned: phases 1, 2 |
| 9 | File upload (admin) | T: unsafe file type, oversized file, path traversal. D: storage exhaustion. | Allow-list of types, size cap, generated file names, daily cap, fails closed. | Planned: phase 2 |
| 10 | Database and cache | T/I: SQL injection, over-privileged login. D: free-tier compute used up. R: audit rows edited. | ORM only, separate runtime and migration logins, audit table insert-only for the runtime login, public reads served from cache. | Planned: phases 1, 7 |
| 11 | Origin and hosting | S: traffic that bypasses Cloudflare. I: verbose errors. E: container escape. | Origin lock, generic error pages, non-root read-only containers, instance cap of 2. | Containers in place; origin lock phase 7 |
| 12 | Build and deploy pipeline | T: malicious dependency or action, tampered image. E: stolen deploy key. | Lockfile and hash-pinned installs, actions pinned to commit hashes, audits, CodeQL, Dependabot, Workload Identity Federation (no stored keys), approval on a protected environment. | Pinning, audits, CodeQL, Dependabot in place; rest phases 6, 7 |

## CV abuse cases (phase 4C-1)

- A link passed to someone else works for at most 60 seconds, and stops at once when another version goes live or viewing is turned off. Getting links is limited per client and per day; each fetch is logged.
- A link from another signing purpose, a changed or made-up token, or one naming an old version gets the same 404 as nonsense. The token carries a keyed hash, so it cannot be turned into a version id.
- A script hammering `/cv/link` without passing Turnstile spends only its own hourly allowance; the site's daily cap counts only visitors who passed.
- Turnstile, Redis or the database down: no link, no file, nothing stored (503).
- Header injection through the request's name or email is refused (one line only); the note is message text and never reaches a header. The site sends no email at all.
- A blocked sender is told "received" and nothing is stored, as on the contact form.
- An encrypted PDF, one with script or launch actions or attached files, a renamed non-PDF and a ZIP behind a PDF header are refused before anything is stored. The check is a heuristic; the only uploader is the owner behind a passkey.
- The view log holds no address, email or free text; the country is only a two-letter code, and the user agent is cleaned and cut. Raw rows go after 90 days; only day totals stay.

## Out of scope

Visitor accounts (there are none), and compromise of the GitHub, Cloudflare or Google Cloud accounts themselves beyond the separate-account and MFA measures in the design.
