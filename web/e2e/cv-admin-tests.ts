import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { API, formHeaders, nextAddress, sendMessage, turnstileToken } from "./fixtures/contact";
import { scriptedPdf, seededPdf } from "./fixtures/cv";

// The CV page of the admin suite. It runs inside admin.spec.ts, after the owner
// has signed in. The live CV the site shows is the one the API's browser-test
// server seeds; these tests upload copies of the same file, so whichever is live
// the public tests see the same two pages, and they put the first one back.
// Every vital action asked for here is cancelled before the next test, because
// the other admin tests expect an empty pending list.

const PAGE = "/desk/cv";

async function confirmPasskey(page: Page, ready: Locator) {
  // The passkey is asked for only if it was not confirmed in the last few
  // minutes, so either may come first.
  const dialog = page.getByRole("dialog", { name: "Confirm with your passkey" });
  await expect(dialog.or(ready)).toBeVisible();
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "Use passkey" }).click();
}

const versions = (page: Page) => page.getByTestId("cv-version");
const badge = (page: Page) => page.getByText("Live", { exact: true });
const liveRow = (page: Page) => versions(page).filter({ has: badge(page) });
const olderRows = (page: Page) => versions(page).filter({ hasNot: badge(page) });
const notice = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

async function noHorizontalScroll(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function upload(page: Page, bytes: Buffer, name = "cv.pdf", mimeType = "application/pdf") {
  await page.getByLabel(/Choose a PDF/).setInputFiles({ name, mimeType, buffer: bytes });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
}

/** A view or a download from a visitor, through the real public routes. */
async function visit(request: import("@playwright/test").APIRequestContext, kind: "view" | "download") {
  const headers = formHeaders(nextAddress());
  const route = kind === "view" ? "link" : "request";
  const data =
    kind === "view"
      ? { turnstile: turnstileToken() }
      : {
          email: `cv.admin.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}@example.com`,
          name: "",
          note: "",
          website: "",
          elapsed: 5000,
          turnstile: turnstileToken(),
        };
  const answer = await request.post(`${API}/api/v1/cv/${route}`, { headers, data });
  expect(answer.status()).toBeLessThan(300);
  const { url } = (await answer.json()) as { url: string };
  const file = await request.get(`${API}${url}`, { headers });
  expect(file.status()).toBe(200);
}

const run = Date.now().toString(36);
const REQUESTER = `cvreq.${run}@example.com`;
const NOTE = "Please send the accessible copy.";

async function askForCopy(request: import("@playwright/test").APIRequestContext) {
  const answer = await request.post(`${API}/api/v1/cv/request`, {
    headers: formHeaders(nextAddress()),
    data: { email: REQUESTER, name: "", note: NOTE, website: "", elapsed: 5000, turnstile: turnstileToken() },
  });
  expect(answer.status()).toBe(201);
}

export function cvAdminTests(getPage: () => Page) {
  test.describe("cv", () => {
    test.describe.configure({ mode: "serial" });

    test("the CV page is in the navigation and shows the live version and the switches", async () => {
      const page = getPage();
      await page.goto("/desk/sections");
      await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "CV", exact: true }).click();
      await expect(page).toHaveURL(/\/desk\/cv$/);
      await expect(page.getByRole("heading", { level: 1, name: "CV" })).toBeVisible();
      await expect(page.getByRole("link", { name: "CV", exact: true })).toHaveAttribute("aria-current", "page");

      for (const label of ["Viewing", "Requests", "Instant download"]) {
        await expect(page.getByRole("switch", { name: new RegExp(label) })).toBeChecked();
      }
      await expect(page.getByRole("button", { name: "Ask to change the switches" })).toBeDisabled();

      await expect(liveRow(page)).toHaveCount(1);
      await expect(liveRow(page)).toContainText("bytes");
      // The live version cannot be deleted, and the page says why.
      await expect(liveRow(page).getByRole("button", { name: "Delete for good" })).toHaveCount(0);
      await expect(liveRow(page)).toContainText("The live version cannot be deleted.");
      await expect(liveRow(page).getByRole("button", { name: "Set live" })).toHaveCount(0);
    });

    test("a file that is not a PDF is stopped here, or refused with the API's own words", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(versions(page).first()).toBeVisible();
      const requests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/cv/versions")) requests.push(request.url());
      });

      // A hint before sending: wrong name, nothing sent.
      await upload(page, Buffer.from("hello"), "cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      await expect(page.locator("#cv-file-error")).toContainText("Choose a PDF file.");
      expect(requests).toHaveLength(0);

      // Right name and type, wrong bytes: the API says so.
      await upload(page, Buffer.from("this is not a pdf"));
      await confirmPasskey(page, page.locator("#cv-file-error").getByText("Choose a PDF file."));
      await expect(page.locator("#cv-file-error")).toContainText("Choose a PDF file.");
      await expect(page.getByLabel(/Choose a PDF/)).toHaveAttribute("aria-invalid", "true");
      await expect(versions(page)).toHaveCount(1);

      // A PDF that holds a script.
      await upload(page, scriptedPdf());
      await expect(page.locator("#cv-file-error")).toContainText("That PDF holds scripts");
      await expect(versions(page)).toHaveCount(1);
    });

    test("the API's message is shown when the versions are full or the file is too large", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(versions(page).first()).toBeVisible();
      await page.route(`${API}/api/v1/admin/cv/versions`, (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "http://localhost:3100", "Access-Control-Allow-Credentials": "true" },
          body: JSON.stringify({
            detail: "Keep at most 10 versions. Delete one before uploading another.",
            code: "cv_versions_full",
          }),
        });
      });
      await upload(page, seededPdf());
      await expect(page.locator("#cv-file-error")).toContainText("Keep at most 10 versions. Delete one before uploading another.");
      await page.unroute(`${API}/api/v1/admin/cv/versions`);

      await page.route(`${API}/api/v1/admin/cv/versions`, (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status: 413,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "http://localhost:3100", "Access-Control-Allow-Credentials": "true" },
          body: JSON.stringify({ detail: "x", errors: { file: ["Use a PDF under 5 MB."] } }),
        });
      });
      await upload(page, seededPdf());
      await expect(page.locator("#cv-file-error")).toContainText("Use a PDF under 5 MB.");
      await expect(page.locator("#cv-file-error")).not.toContainText("image");
      await page.unroute(`${API}/api/v1/admin/cv/versions`);
    });

    test("a full list turns the upload off and says why", async () => {
      const page = getPage();
      const row = (n: number) => ({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        size: 1000 + n,
        sha256: "b".repeat(64),
        created_at: "2026-11-01T10:00:00+00:00",
        is_live: n === 0,
        file: "",
      });
      await page.route(`${API}/api/v1/admin/cv/versions`, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "http://localhost:3100", "Access-Control-Allow-Credentials": "true" },
          body: JSON.stringify({ versions: Array.from({ length: 10 }, (_, n) => row(n)), max_versions: 10 }),
        });
      });
      await page.goto(PAGE);
      await expect(versions(page)).toHaveCount(10);
      await expect(page.getByTestId("cv-count")).toContainText("10 of 10 versions in use. Delete one before uploading another.");
      await expect(page.getByLabel(/Choose a PDF/)).toBeDisabled();
      await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
      await page.unroute(`${API}/api/v1/admin/cv/versions`);
    });

    test("a good PDF is stored but not live, and Set live needs the passkey and swaps the badge", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(versions(page)).toHaveCount(1);
      await upload(page, seededPdf());
      await confirmPasskey(page, notice(page, "Uploaded. It is not live yet"));
      await expect(versions(page)).toHaveCount(2);
      await expect(liveRow(page)).toHaveCount(1);
      await expect(page.getByTestId("cv-count")).toContainText("2 of 10 versions in use.");

      const spare = olderRows(page);
      await expect(spare).toHaveCount(1);
      await spare.getByRole("button", { name: "Set live" }).click();
      await confirmPasskey(page, notice(page, "That version is now the live one."));
      await expect(liveRow(page)).toHaveCount(1);
      // The one that was live now offers Set live, and can be deleted.
      await expect(olderRows(page).getByRole("button", { name: "Set live" })).toBeVisible();
      await expect(liveRow(page).getByRole("button", { name: "Delete for good" })).toHaveCount(0);

      const status = await page.request.get(`${API}/api/v1/cv`);
      expect(((await status.json()) as { can_view: boolean }).can_view).toBe(true);
    });

    test("an older version can be downloaded to attach to an email", async () => {
      const page = getPage();
      await page.goto(PAGE);
      const older = olderRows(page);
      await expect(older).toHaveCount(1);
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        older.getByRole("link", { name: "Download to attach" }).click(),
      ]);
      expect(file.suggestedFilename()).toMatch(/\.pdf$/);
    });

    test("deleting a version needs the passkey, waits 24 hours and can be cancelled; the live one cannot be deleted", async () => {
      const page = getPage();
      await page.goto(PAGE);
      const older = olderRows(page);
      await expect(older).toHaveCount(1);
      await older.getByRole("button", { name: "Delete for good" }).click();
      await confirmPasskey(page, notice(page, "It will be deleted for good after 24 hours."));
      const waiting = older.getByTestId("cv-deleting");
      await expect(waiting).toContainText(/Can run in (23 h 5\d|24 h 0) min\./);
      await expect(older.getByRole("button", { name: "Delete for good" })).toHaveCount(0);
      // Nothing was removed.
      await expect(versions(page)).toHaveCount(2);
      await expect(page.getByText("1 vital action is waiting.")).toBeVisible();

      // Still there after a reload, and in the pending list.
      await page.reload();
      await expect(older.getByTestId("cv-deleting")).toBeVisible();
      await page.goto("/desk/pending");
      await expect(page.getByTestId("pending-row").filter({ hasText: "Delete a CV version for good" })).toHaveCount(1);

      await page.goto(PAGE);
      await older.getByRole("button", { name: "Cancel deletion" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Cancelled. The version was kept." })).toBeVisible();
      await expect(older.getByTestId("cv-deleting")).toHaveCount(0);
      await expect(older.getByRole("button", { name: "Delete for good" })).toBeVisible();
      await expect(versions(page)).toHaveCount(2);

      // The first, seeded version is put live again, so the site shows what it did.
      await older.getByRole("button", { name: "Set live" }).click();
      await confirmPasskey(page, notice(page, "That version is now the live one."));
      await page.goto("/desk/pending");
      await expect(page.getByText("Nothing is waiting.")).toBeVisible();
    });

    test("changing the switches shows the pending change with its 24-hour wait, and cancel leaves them as they were", async () => {
      const page = getPage();
      await page.goto(PAGE);
      const ask = page.getByRole("button", { name: "Ask to change the switches" });
      await expect(ask).toBeDisabled();
      await page.getByRole("switch", { name: /Viewing/ }).uncheck();
      await page.getByRole("switch", { name: /Instant download/ }).uncheck();
      await expect(ask).toBeEnabled();
      await ask.click();
      await confirmPasskey(page, page.getByTestId("pending-row"));

      const row = page.getByTestId("pending-row");
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Change the CV switches");
      await expect(row.getByTestId("cv-summary")).toHaveText("View: off. Request: on. Instant download: off.");
      await expect(row.getByTestId("time-left")).toContainText(/Can run in (23 h 5\d|24 h 0) min\./);
      await expect(page.getByRole("status").filter({ hasText: "Requested. It can run after 24 hours" })).toBeVisible();
      // The switches themselves have not changed, and cannot be asked for again.
      await expect(page.getByRole("switch", { name: /Viewing/ })).toBeChecked();
      await expect(page.getByRole("switch", { name: /Viewing/ })).toBeDisabled();
      await expect(page.getByText("1 vital action is waiting.")).toBeVisible();
      const status = (await (await page.request.get(`${API}/api/v1/cv`)).json()) as { can_view: boolean };
      expect(status.can_view).toBe(true);

      // It is in the pending list too, described in words.
      await page.goto("/desk/pending");
      const listed = page.getByTestId("pending-row").filter({ hasText: "Change the CV switches" });
      await expect(listed.getByTestId("cv-summary")).toBeVisible();

      await page.goto(PAGE);
      await page.getByTestId("pending-row").getByRole("button", { name: "Cancel this action" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Cancelled. Nothing was changed." })).toBeVisible();
      await expect(page.getByTestId("pending-row")).toHaveCount(0);
      await expect(page.getByRole("switch", { name: /Viewing/ })).toBeEnabled();
      await expect(page.getByRole("switch", { name: /Viewing/ })).toBeChecked();
      await page.goto("/desk/pending");
      await expect(page.getByText("Nothing is waiting.")).toBeVisible();
    });

    test("the log lists views and downloads with no address or email, and the counts add up", async ({ request }) => {
      const page = getPage();
      await visit(request, "view");
      await visit(request, "download");
      for (let i = 0; i < 26; i += 1) await visit(request, "view");

      await page.goto(PAGE);
      const rows = page.getByTestId("cv-view-row");
      await expect(rows.first()).toBeVisible();
      expect(await rows.count()).toBe(25);
      await expect(page.getByText(/Page 1 of [2-9]/)).toBeVisible();
      await expect(rows.first()).toContainText(/Viewed|Downloaded/);
      await expect(rows.first()).toContainText("Country:");

      const text = await page.locator("main").innerText();
      expect(text).not.toMatch(/203\.0\.113\.\d+/);
      expect(text).not.toMatch(/@example\.com/);

      // Counts per day, newest first, with a total.
      const today = page.getByTestId("cv-day").first();
      await expect(today).toContainText(/\d+ visits?/);
      await expect(page.getByText(/\d+ in all\./)).toBeVisible();

      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText(/Page 2 of/)).toBeVisible();
      expect(await rows.count()).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
    });

    test("the download in the log is told apart from a view", async ({ request }) => {
      const page = getPage();
      await visit(request, "download");
      await page.goto(PAGE);
      await expect(page.getByTestId("cv-view-row").filter({ hasText: "Downloaded" }).first()).toBeVisible();
    });

    test("the CV page fits a phone and has no accessibility violations at 390 and 1280 px, light and dark", async () => {
      const page = getPage();
      for (const width of [390, 1280]) {
        for (const scheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(PAGE);
          await expect(versions(page).first()).toBeVisible();
          await expect(page.getByTestId("cv-view-row").first()).toBeVisible();
          await noHorizontalScroll(page, width);
          const found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `${width}px ${scheme}`).toEqual([]);
        }
      }
      await page.emulateMedia({ colorScheme: null });
    });

    test("a CV request has a badge in the list and the detail, the filter narrows to it, and replying works as for any message", async ({
      request,
    }) => {
      const page = getPage();
      await askForCopy(request);
      await sendMessage(request, {
        name: "Ordinary Person",
        email: `ordinary.${run}@example.com`,
        reason: "other",
        body: `An ordinary message for the filter test (${run}).`,
      });
      const list = `/desk/messages?q=${run}`;
      await page.goto(list);
      const messageRows = page.getByTestId("message-row");
      await expect(messageRows).toHaveCount(2);
      await expect(page.getByTestId("kind-badge")).toHaveCount(1);
      const cvRow = messageRows.filter({ has: page.getByTestId("kind-badge") });
      await expect(cvRow).toContainText("CV request");
      await expect(cvRow.getByRole("link", { name: "No name given" })).toBeVisible();
      await expect(cvRow).toContainText("Request for a copy of the CV.");
      await expect(messageRows.filter({ hasText: "Ordinary Person" }).getByTestId("kind-badge")).toHaveCount(0);

      // The filter: all, or CV requests only. It keeps the address, the folders and the search.
      await page.getByLabel("Show").selectOption("cv_request");
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page).toHaveURL(/kind=cv_request/);
      await expect(messageRows).toHaveCount(1);
      await expect(page.getByTestId("kind-badge")).toHaveCount(1);
      await expect(page.getByRole("link", { name: /^Inbox/ })).toHaveAttribute("href", /kind=cv_request/);
      await page.reload();
      await expect(messageRows).toHaveCount(1);
      await expect(page.getByLabel("Show")).toHaveValue("cv_request");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page).not.toHaveURL(/kind=/);
      await expect(page.getByLabel("Show")).toHaveValue("");
      await page.goto(`${list}&kind=nonsense`);
      await expect(messageRows).toHaveCount(2);

      // The detail shows the badge, the fixed line and the note, and a reply by email.
      await page.goto(`${list}&kind=cv_request`);
      await page.getByRole("link", { name: "No name given" }).click();
      await expect(page.getByRole("heading", { name: "Message with no name given" })).toBeFocused();
      await expect(page.getByTestId("kind-badge")).toBeVisible();
      await expect(page.getByText("Request for a copy of the CV.", { exact: false }).first()).toBeVisible();
      await expect(page.getByText(NOTE)).toBeVisible();
      await expect(page.getByRole("link", { name: "Reply by email" })).toHaveAttribute(
        "href",
        new RegExp(`^mailto:${REQUESTER.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\?subject=`),
      );
      // The Back link keeps the filter.
      await expect(page.getByRole("link", { name: /^Back to/ })).toHaveAttribute("href", /kind=cv_request/);
    });

    test("the filtered list and a CV request have no accessibility violations at 390 and 1280 px, light and dark", async () => {
      const page = getPage();
      for (const width of [390, 1280]) {
        for (const scheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(`/desk/messages?q=${run}&kind=cv_request`);
          await expect(page.getByTestId("kind-badge").first()).toBeVisible();
          await noHorizontalScroll(page, width);
          let found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `list ${width}px ${scheme}`).toEqual([]);
          await page.getByRole("link", { name: "No name given" }).click();
          await expect(page.getByRole("heading", { name: "Message with no name given" })).toBeVisible();
          await noHorizontalScroll(page, width);
          found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `detail ${width}px ${scheme}`).toEqual([]);
        }
      }
      await page.emulateMedia({ colorScheme: null });
    });

    test("the seeded version is the live one again", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(liveRow(page)).toHaveCount(1);
      const status = (await (await page.request.get(`${API}/api/v1/cv`)).json()) as { can_view: boolean };
      expect(status.can_view).toBe(true);
    });
  });
}
