# Access

Every principal that can touch the system, what it can and cannot do, and how to rotate or revoke it. The admin's Access review page (`GET /api/v1/admin/access`) shows the same list with live data where the API can see it: sessions, passkeys, the real database grants, whether each secret is set and when it was last used. The rest is described here and marked "not checked by the app" on the page.

## The owner

| Principal | Can | Cannot | Credential | Expiry | Revoke or rotate |
|---|---|---|---|---|---|
| Sessions | Everything in the admin; start a vital action after confirming the passkey again | Run a vital action before its 24-hour wait; stay confirmed for more than 5 minutes | Random token in an HttpOnly cookie; only its SHA-256 is stored | 15 minutes idle, 8 hours at most | Admin: "Sign out everywhere" (`POST /admin/sessions/revoke-all`, passkey confirmation) |
| Passkeys | Sign in (with Cloudflare Access); confirm vital actions | Sign in without Access; be copied from the site (only the public key is stored) | WebAuthn passkey on the owner's device | None | Admin: remove passkey, a vital action (`revoke_passkey`) with the 24-hour wait. In an emergency: "Remove all access" (`POST /admin/access/revoke-all`) |
| Recovery key | Replace every passkey with one new one, end every session, cancel pending vital actions | Work without Cloudflare Access; be shown again; be used twice | Random key shown once at bootstrap or recovery, kept offline; only its hash is stored | None; using it issues a new one | Use it (recovery replaces it). Keep the printed copy somewhere only the owner can reach. |
| Cloudflare Access | Let a request reach `/api/v1/admin/` for the one email address the policy names | Sign in by itself; let anything through if the API's `CF_ACCESS_*` settings are missing | Token Cloudflare signs per request, checked by the API every time | The Access session length set in the policy | Cloudflare Zero Trust dashboard: revoke the owner's Access sessions, or change the policy |

## Database

| Principal | Can | Cannot | Credential | Revoke or rotate |
|---|---|---|---|---|
| `app_rw` (the running API) | Exactly the grants in `api/db/grants.sql`: content tables in full, append to the audit log, column-limited updates elsewhere | Change the schema; read `django_migrations`; edit or delete audit rows (a trigger also blocks it); empty any table | Password of a login user that is a member of `app_rw`, in Secret Manager | Make a new password in Neon, update the secret, deploy a new revision, then remove the old password |
| `migrator` | Create and change tables in the `public` schema; owns the tables it creates | Run except from the deploy pipeline after the manual approval; be used by the running API | Password of a login user that is a member of `migrator`, in Secret Manager, readable only by the pipeline | Same as above, for the pipeline's secret only |

The Access review page reads the real rights of both roles from the database and lists them; a test fails if the page and `information_schema` disagree. It also says if the API is connected as a superuser instead of `app_rw`, which must never be the case in production.

## Infrastructure (not checked by the app)

| Principal | Can | Cannot | Credential | Revoke or rotate |
|---|---|---|---|---|
| Deploy pipeline (GitHub Actions) | Build and push the API image; deploy a new Cloud Run revision; run migrations as `migrator` after approval | Read content or messages; deploy to production without the protected environment's approval | Workload Identity Federation: a short-lived Google token per run, no stored key | Remove the workload identity pool binding in IAM, or require a fresh approval on the protected environment |
| Cloudflare API token | Purge the cache in the site's zone | Change DNS, firewall rules, Access policies or any other setting; read content | API token with Zone, Cache Purge permission on one zone, in Secret Manager (`CLOUDFLARE_PURGE_TOKEN`) | Roll the token in the Cloudflare dashboard, update the secret, deploy |
| Pages deploy hook | Start a rebuild of the public site from `main` | Change what is built; read anything | Secret URL in Secret Manager (`PAGES_DEPLOY_HOOK_URL`) | Delete the hook in Cloudflare Pages, make a new one, update the secret |

The deploy pipeline and its Workload Identity Federation are set up in Phase 7; until then nothing deploys automatically.

## Quarterly review

A calendar item every three months. About two minutes:

1. Open the Access review page in the admin.
2. Sessions: only the one you are using should be listed. If not, sign out everywhere.
3. Passkeys: each one should be a device you still have. Remove any other.
4. Database roles: `app_rw` should match `api/db/grants.sql` and say it is connected as this role; any warning about a superuser connection is fixed before anything else.
5. Recovery key: should be set, and its last use should be one you remember.
6. Infrastructure: check in Cloudflare that the API token still has Cache Purge only, and in Google Cloud IAM that the pipeline's identity has only the roles listed above.
7. Write down the date and anything you changed.
