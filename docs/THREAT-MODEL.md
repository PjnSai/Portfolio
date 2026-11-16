# Threat model

Method: STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege). Reviewed at every phase and before each release.

Status key: **in place** (control and test exist), **planned** (phase named).

## Assets

Site content, the admin session and passkey, contact messages, the CV file, deploy credentials, the audit log, and the free-tier budget.

## Trust boundaries

Internet to Cloudflare; Cloudflare to Cloud Run (web, api); api to Postgres and Redis; api to email and captcha services; GitHub Actions to Google Cloud.

## Threats by surface

| # | Surface | Main threats (STRIDE) | Controls | Status |
|---|---------|-----------------------|----------|--------|
| 1 | Public pages (home, sections, project pages) | T: stored XSS through content. I: draft or hidden content shown. D: floods. | Output encoding, sanitised Markdown, strict CSP; only published content rendered; pages cached at the edge and readable without JavaScript. | Planned: phases 3, 6 |
| 2 | Public read API (`/api/v1`) | I: unpublished data, object ID guessing. D: database exhaustion. T: injection. | Deny by default, explicit public endpoints, random IDs, ORM only (raw SQL blocked in CI), rate limits, cached reads. | Deny by default and raw SQL check in place; rest phases 1 to 3 |
| 3 | Contact form | S: bots. T: email header injection, spam links. D: message and email floods. I: enumeration by response. | Turnstile and honeypot, schema validation, length caps, per-IP and daily caps, generic responses, fails closed if a dependency is down. | Planned: phase 4 |
| 4 | CV download | I: private file exposed, path traversal. D: bandwidth abuse. | Fixed object reference (no user-supplied path), private storage if gated, edge caching and rate limit. | Planned: phase 4 |
| 5 | Images and media | T: script served as an image. I: EXIF location data. | Type sniffing and re-encoding, EXIF stripping, `nosniff`, separate storage origin. | Planned: phase 2 |
| 6 | Health and status (`/healthz`, `/api/v1/status`) | I: version or configuration leak. D: cheap request flood. | Fixed body with no version or dependency detail, never cached, covered by edge rate limit. | In place (edge limit: phase 7) |
| 7 | Admin sign-in | S: credential theft, session fixation. I: account enumeration. D: lock-out attack. | Passkey behind Cloudflare Access, server-side sessions with `__Host-` cookies, rotation on login, generic responses and equal timing, rate limit with cool-down. | Planned: phase 1 |
| 8 | Admin editing API | E: access without a valid session. T: CSRF, mass assignment, IDOR. R: unlogged change. | Session check on every route, CSRF token with Origin and Fetch-Metadata checks, explicit serializer fields, hash-chained audit log, fresh passkey and delay for vital actions. | Planned: phases 1, 2 |
| 9 | File upload (admin) | T: unsafe file type, oversized file, path traversal. D: storage exhaustion. | Allow-list of types, size cap, generated file names, daily cap, fails closed. | Planned: phase 2 |
| 10 | Database and cache | T/I: SQL injection, over-privileged login. D: free-tier compute used up. R: audit rows edited. | ORM only, separate runtime and migration logins, audit table insert-only for the runtime login, public reads served from cache. | Planned: phases 1, 7 |
| 11 | Origin and hosting | S: traffic that bypasses Cloudflare. I: verbose errors. E: container escape. | Origin lock, generic error pages, non-root read-only containers, instance cap of 2. | Containers in place; origin lock phase 7 |
| 12 | Build and deploy pipeline | T: malicious dependency or action, tampered image. E: stolen deploy key. | Lockfile and hash-pinned installs, actions pinned to commit hashes, audits, CodeQL, Dependabot, Workload Identity Federation (no stored keys), approval on a protected environment. | Pinning, audits, CodeQL, Dependabot in place; rest phases 6, 7 |

## Out of scope

Visitor accounts (there are none), and compromise of the GitHub, Cloudflare or Google Cloud accounts themselves beyond the separate-account and MFA measures in the design.
