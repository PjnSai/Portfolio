# Running the site on your own PC

Local mode runs the whole site on this computer: the API, the public site, the admin at `/desk`, the CV pop-up and the request form. It uses its own database, `portfolio_dev`, filled with SAMPLE content. Nothing you do here reaches the live site, and nothing here carries over to it: content you enter locally stays local.

All commands are for Windows PowerShell, run from the repository folder (the one that holds `api`, `web` and `scripts`).

## What is real and what is stood in

Stood in, on this computer only:

- **The Cloudflare Access gate.** Live, Cloudflare checks your login before a request reaches the admin. Locally, the launcher (`api/devmode`) makes a throwaway signing key when it starts, keeps it in memory and adds a fresh 60-second Access token to every request that comes from this computer. The API's own check (`core/access.py`) is unchanged and still checks every token in full.
- **Turnstile.** Cloudflare's published test keys, which always pass. The widget still loads from Cloudflare, so the request form needs an internet connection.
- **Email and notices.** Nothing is sent. Notices go to the API log (`api\.devmode\run\api.log`).
- **Storage.** Images and CV files are kept on disk in `api\.devmode\media` and `api\.devmode\cv`, not in Cloud Storage.
- **Publish.** It does not rebuild anything by itself. The public site is a static build, so you rebuild it with one command (below).
- **Database rights.** The dev API connects as the container's superuser, so the limits in `db/grants.sql` are applied but not enforced. The access review shows its superuser warning.

Real: the passkey sign-in (Windows Hello), sessions, CSRF checks, the admin's security headers and CSP, rate limits, and every check the API makes on what you enter.

## What the launcher refuses

`python -m devmode` stops with a message and does nothing if any of these is true: the database name does not end in `_dev`; the database or Redis is not on this computer; it is asked to listen anywhere but 127.0.0.1; or the window it runs in has production values set (`CLOUDFLARE_PURGE_TOKEN`, `CLOUDFLARE_ZONE_ID`, `PAGES_DEPLOY_HOOK_URL`, a `GCS_...` bucket, a real `TURNSTILE_SECRET_KEY`, a `SITE_ORIGIN` that is not localhost, or Cloud Run's own variables). It checks again after Django has loaded its settings. It reads no `.env` file.

## 1. Prerequisites (once)

1. **Docker Desktop**, running. The two containers the tests use must exist: `portfolio-test-db` (Postgres, port 55432) and `portfolio-test-redis` (Redis, port 6379). If they do not, `.\scripts\dev.ps1 start` prints the exact `docker run` command to create each one.
2. **Python virtual environment** for the API at `api\.venv` (the same one the tests use). To make it:
   ```powershell
   cd api
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install --require-hashes -r requirements-dev.txt
   cd ..
   ```
   This reads `api\requirements-dev.txt` and writes `api\.venv`.
3. **Node.js 24** and the web packages:
   ```powershell
   cd web
   npm ci
   cd ..
   ```
   This reads `web\package-lock.json` and writes `web\node_modules`.
4. **Allow local scripts**, if PowerShell says running scripts is disabled:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```
   This changes a setting for your Windows user only. Or run each command as `powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 start`.

## 2. Start

```powershell
.\scripts\dev.ps1 start
```

What it does, in order (it prints each step before it does it):

1. Reads whether Docker is running and whether the two containers are up; starts them with `docker start` if they are stopped.
2. The first time only, creates the database `portfolio_dev` in the Postgres container, applies the migrations and `db/roles.sql` and `db/grants.sql`, and adds the SAMPLE content. An existing `portfolio_dev` is left as it is.
3. Starts the API on http://127.0.0.1:8000 in a hidden window and writes a new set-up token to `api\.devmode\bootstrap-token`.
4. Builds the public site into `web\out` from the API (a minute or two), then serves it on http://localhost:3000.
5. Prints the addresses and the set-up token.

`.\scripts\dev.ps1 start -NoBuild` skips the build and serves the last one.

Logs are in `api\.devmode\run`: `api.log`, `web.log` and `web-build.log`.

## 3. Your first local passkey (once)

1. Open http://localhost:3000/desk/setup in Edge or Chrome. (Use `localhost`, not `127.0.0.1`: passkeys need a name.)
2. Paste the set-up token that `start` printed. It is also in `api\.devmode\bootstrap-token`.
3. Choose **Create passkey** and confirm with Windows Hello.
4. The page shows a recovery key once. This is a local one, for the local database only; keep it until you reset everything. Tick the box and choose **Continue to sign in**.

The local passkey is saved in Windows Hello for "localhost". It is separate from any passkey for the live site.

## 4. Sign in afterwards

Open http://localhost:3000/desk and choose **Sign in with passkey**.

## 5. Enter content

In the admin:

- **Sections** (`/desk/sections`): the intro, about, projects and the rest. Edit a section, then **Publish** it.
- **Settings** (`/desk/settings`): site title, description, palettes and layout, then **Publish**.
- **Messages** (`/desk/messages`): two SAMPLE messages, one of them a CV request.
- **Abuse counts and alerts**: a few SAMPLE counts and two SAMPLE alerts are in the database. The admin pages for them come with the Phase 5 web work; until then the API answers at `/api/v1/admin/abuse` and `/api/v1/admin/alerts`.

Actions marked as vital (for example the CV switches) wait 24 hours, as they do live. Their notices appear in `api.log`.

## 6. The CV, the pop-up and the request form

1. Go to http://localhost:3000/desk/cv. A two-page SAMPLE CV is already live, with viewing, requests and instant download all on.
2. To try your own PDF, upload it there and make it live. Choose a file with nothing private in it: it is stored in `api\.devmode\cv` on this PC.
3. Open http://localhost:3000 and scroll to the CV block. **View the CV** opens the pop-up.
4. Fill in the request form with a made-up name and an address at `example.com`, then **Request a copy**. With instant download on, a **Download the CV** link appears for a minute. The request shows in `/desk/messages` as a CV request.

## 7. See your changes on the public site

Publish only saves the change: the API log says `site deploy skipped: development deployer`. The public pages are built from the published content, so rebuild them:

```powershell
.\scripts\dev.ps1 refresh
```

This reads the published content from the API, rebuilds `web\out` and restarts the site server. Reload the page in the browser when it says the site is up. The admin itself needs no rebuild.

## 8. Status and stop

```powershell
.\scripts\dev.ps1 status
.\scripts\dev.ps1 stop
```

`status` only reads: Docker, the two containers, the API and the site. `stop` stops the site server and the API (and only those, using the process ids in `api\.devmode\run`). The containers keep running, because the tests use them; stop them in Docker Desktop if you want.

## 9. Reset

```powershell
.\scripts\dev.ps1 reset
```

Asks you to type `yes`, then replaces the content, CV versions, media, messages, contacts, blocklist, counts and alerts in `portfolio_dev` with the SAMPLE content, empties the dev Redis database (13), and rebuilds the site if the API is running. Your local passkeys, sessions and the audit log are kept.

```powershell
.\scripts\dev.ps1 reset -Everything
```

Asks you to type `yes`, stops local mode, then deletes the database `portfolio_dev`, `api\.devmode\media`, `api\.devmode\cv` and the set-up token. The next `start` begins from nothing, and you make a new first passkey. You can delete the old "localhost" passkey in Windows Settings, Accounts, Passkeys.

Neither touches the test databases (`portfolio`, `portfolio_e2e`) or the live site.

## 10. The real tests

Local mode does not change them. They use their own databases in the same containers (`portfolio` and `portfolio_e2e`, Redis 14 and 15), so they can run while local mode is running, except that the browser tests need ports 3100 and 8100 free.

```powershell
cd api
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:55432/portfolio"
.venv\Scripts\ruff.exe check .
.venv\Scripts\ruff.exe format --check .
.venv\Scripts\python.exe -m pytest -q
cd ..\web
npm run lint; npm run typecheck; npm test
$env:E2E_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:55432/portfolio_e2e"
$env:E2E_PYTHON = "..\api\.venv\Scripts\python.exe"
npm run e2e
```

Note: `npm run e2e` rebuilds `web\out` for its own test server. Run `.\scripts\dev.ps1 refresh` afterwards before using local mode again.

## Troubleshooting

- **"The admin cannot reach the server."** The API is not running or stopped. Run `.\scripts\dev.ps1 status`; if the API is not answering, run `.\scripts\dev.ps1 start` and look at `api\.devmode\run\api.log`.
- **"Docker is not running."** Start Docker Desktop and wait until it says it is running.
- **"The container ... does not exist."** Run the `docker run` command it prints, once.
- **"Port 8000 (or 3000) is already in use by ..."** Something else is listening there, for example `npm run dev` or another copy of the site. Stop it (close its window, or `Stop-Process -Id <number>` with the number shown), then start again. If it is an old local mode, `.\scripts\dev.ps1 stop` first.
- **"Cannot reach Postgres for the dev database."** The `portfolio-test-db` container is not running or not on port 55432. Check with `.\scripts\dev.ps1 status`.
- **"Refusing to start local mode"** followed by a reason. A production value is set in this PowerShell window (see the list above). Open a new window that does not set it.
- **The home page shows a placeholder instead of the SAMPLE content (an empty database).** Run `.\scripts\dev.ps1 reset` to put the SAMPLE content back, or publish your own sections, then `.\scripts\dev.ps1 refresh`.
- **A change does not show on the public site.** Did you Publish it, and run `.\scripts\dev.ps1 refresh` afterwards?
- **"Set-up is closed."** A local passkey already exists. Sign in with it, or use `reset -Everything` to start again.
- **The site build failed.** The last 25 lines of `web-build.log` are printed. The API must be running for a build.
- **The request form never finishes.** Turnstile needs an internet connection to load its widget, even with the test keys.
