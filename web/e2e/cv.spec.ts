import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { API } from "./fixtures/contact";
import {
  consoleProblems,
  reachCv,
  stubHeldTurnstile,
  stubPost,
  stubStatus,
  withCvAddress,
} from "./fixtures/cv";
import { stubTurnstile } from "./fixtures/form";

// The public CV: the viewer, the request form and the instant download. The
// Turnstile script is replaced by a stand-in, the API is the real one with a
// seeded live CV of two pages, so these tests need no network.

const DIALOG = "dialog.cv-viewer";

async function open(page: Page, options: { held?: boolean; fail?: boolean } = {}) {
  if (options.held) await stubHeldTurnstile(page);
  else await stubTurnstile(page, { fail: options.fail });
  await withCvAddress(page);
  await page.goto("/");
  await reachCv(page);
}

const viewButton = (page: Page) => page.getByRole("button", { name: "View the CV" });

test.describe("the viewer", () => {
  test("opens only after the human check, and not at all if the check fails", async ({ page }) => {
    const links: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/cv/link")) links.push(request.method());
    });
    await open(page, { held: true });
    await expect(viewButton(page)).toBeEnabled();
    await viewButton(page).click();
    await expect(page.getByText("Checking that you are human…")).toBeVisible();
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(links.filter((method) => method === "POST")).toHaveLength(0);

    await page.evaluate(() => (window as unknown as { __passCheck: () => void }).__passCheck());
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} canvas`)).toHaveCount(2);
    expect(links.filter((method) => method === "POST")).toHaveLength(1);
  });

  test("never opens when the check cannot run", async ({ page }) => {
    const links: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/cv/link")) links.push(request.method());
    });
    await open(page, { fail: true });
    await viewButton(page).click();
    await expect(page.getByText("The anti-spam check could not run.")).toBeVisible();
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(links.filter((method) => method === "POST")).toHaveLength(0);
    await expect(viewButton(page)).toBeEnabled();
  });

  test("draws the pages as images with no download control, frame or file address", async ({ page }) => {
    const problems = consoleProblems(page);
    await open(page);
    const before = page.url();
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "CV" })).toBeVisible();
    const pages = dialog.getByRole("img");
    await expect(pages).toHaveCount(2);
    await expect(pages.first()).toHaveAttribute("aria-label", "CV, page 1 of 2, shown as an image");

    // Something was drawn: a page is not left blank.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("dialog.cv-viewer canvas");
          const context = canvas?.getContext("2d");
          if (!canvas || !context) return 0;
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 3] > 0) dark += 1;
          return dark;
        }),
      )
      .toBeGreaterThan(50);

    await expect(dialog.getByRole("button")).toHaveText(["Close"]);
    expect(await dialog.locator("a[download], iframe, object, embed").count()).toBe(0);
    expect(await page.locator('iframe[src*="cv"], object, embed').count()).toBe(0);
    expect(await page.locator('[href*="/cv/file"], [src*="/cv/file"]').count()).toBe(0);
    expect(page.url()).toBe(before);
    expect(await page.content()).not.toContain("/api/v1/cv/file/");
    expect(problems).toEqual([]);
  });

  test("says the pages are images, with a text alternative", async ({ page }) => {
    await open(page);
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText("The CV is shown as page images. For an accessible copy, request one.");
    await expect(dialog.getByRole("status")).toContainText("The CV is shown. It has 2 pages.");
  });

  test("moves focus in, traps it, closes on Escape and gives focus back", async ({ page }) => {
    await open(page);
    await viewButton(page).focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator("canvas")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    // Tab stays inside the dialog, however many times it is pressed.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog.cv-viewer")))).toBe(true);
    }
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog.cv-viewer")))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(viewButton(page)).toBeFocused();
  });

  test("closes with the Close button and can be opened again", async ({ page }) => {
    await open(page);
    await viewButton(page).click();
    await page.locator(DIALOG).getByRole("button", { name: "Close" }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(viewButton(page)).toBeFocused();
    await viewButton(page).click();
    await expect(page.locator(`${DIALOG} canvas`)).toHaveCount(2);
  });

  test("an expired link says so and Try again gets a new one", async ({ page }) => {
    const links: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/cv/link") && request.method() === "POST") links.push("link");
    });
    await open(page);
    let expired = true;
    await page.route(`${API}/api/v1/cv/file/**`, (route) => {
      if (!expired) return route.fallback();
      expired = false;
      return route.fulfill({
        status: 404,
        headers: { "Access-Control-Allow-Origin": "http://localhost:3100" },
        contentType: "application/json",
        body: "{}",
      });
    });
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.getByRole("alert")).toContainText("The link has expired. Try again to get a new one.");
    await expect(dialog.locator("canvas")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.locator("canvas")).toHaveCount(2);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(links).toHaveLength(2);
  });

  for (const [status, text] of [
    [403, "The CV cannot be shown at the moment."],
    [429, "Too many views have been asked for from here."],
    [503, "The CV could not be shown right now."],
  ] as const) {
    test(`a ${status} from the link route is said in plain words`, async ({ page }) => {
      await open(page);
      await stubPost(page, "link", status, { detail: "Raw text that must not be shown." }, status === 429 ? { "Retry-After": "600" } : {});
      await viewButton(page).click();
      const dialog = page.locator(DIALOG);
      await expect(dialog.getByRole("alert")).toContainText(text);
      await expect(dialog).not.toContainText("Raw text");
      await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
    });
  }

  test("fits a 320 px screen and does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator("canvas")).toHaveCount(2);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
  });

  test("does not animate for a visitor who asks for less motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator("canvas")).toHaveCount(2);
    const durations = await dialog.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.transitionDuration, style.animationDuration];
    });
    for (const value of durations) expect(parseFloat(value)).toBe(0);
  });

  test("has no accessibility violations with the viewer open", async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "the matrix runs the other browsers");
    await open(page);
    await viewButton(page).click();
    await expect(page.locator(`${DIALOG} canvas`)).toHaveCount(2);
    const results = await new AxeBuilder({ page }).include(DIALOG).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("the switches", () => {
  test("show nothing about a CV when viewing and requests are both off", async ({ page }) => {
    await stubStatus(page, { can_view: false, can_request: false });
    await open(page);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#cv")).toHaveCount(0);
    await expect(page.locator("[data-cv-root]")).toBeEmpty();
    await expect(page.getByRole("button", { name: "View the CV" })).toHaveCount(0);
    const main = await page.locator("main").innerText();
    expect(main).not.toMatch(/\bCV\b/);
  });

  test("show nothing when the status cannot be read", async ({ page }) => {
    await stubStatus(page, { status: 503 });
    await open(page);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#cv")).toHaveCount(0);
  });

  test("show only the view button when requests are off", async ({ page }) => {
    await stubStatus(page, { can_view: true, can_request: false });
    await open(page);
    await expect(viewButton(page)).toBeVisible();
    await expect(page.locator("#cv-request")).toHaveCount(0);
  });

  test("show no view button when only requests are on", async ({ page }) => {
    await stubStatus(page, { can_view: false, can_request: true });
    await open(page);
    await expect(page.locator("#cv")).toBeVisible();
    await expect(viewButton(page)).toHaveCount(0);
  });

  test("hold no check widget and no viewer code when nothing is on", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await stubStatus(page, { can_view: false, can_request: false });
    await open(page);
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".cv [data-turnstile]")).toHaveCount(0);
    expect(requests.some((url) => /pdf\.worker/.test(url))).toBe(false);
  });
});

// The request form ----------------------------------------------------------

let counter = 0;
const run = Date.now().toString(36);
const fresh = () => {
  counter += 1;
  return { name: "Taylor Tester", email: `cv.${run}.${counter}@example.com`, note: `Note ${counter} from ${run}.` };
};

async function fill(page: Page, values = fresh()) {
  await page.getByLabel(/^Your name/).fill(values.name);
  await page.getByLabel(/^Your email/).fill(values.email);
  await page.getByLabel(/^Note/).fill(values.note);
  return values;
}

const requestButton = (page: Page) => page.getByRole("button", { name: "Request a copy" });
const sentPanel = (page: Page) => page.locator("#cv-request-sent");
const RECEIVED = "Thank you. Your message has been received.";

function requestPosts(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.url() === `${API}/api/v1/cv/request` && request.method() === "POST") {
      bodies.push(JSON.parse(request.postData() ?? "{}"));
    }
  });
  return bodies;
}

test.describe("the request form", () => {
  test("the viewer text alternative leads to it", async ({ page }) => {
    await open(page);
    await viewButton(page).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator("canvas")).toHaveCount(2);
    await dialog.getByRole("link", { name: "request one" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel(/^Your name/)).toBeFocused();
  });

  test("finds a missing email before anything is sent, and says where", async ({ page }) => {
    const posts = requestPosts(page);
    await open(page);
    await requestButton(page).click();
    await expect(page.getByLabel(/^Your email/)).toBeFocused();
    await expect(page.getByLabel(/^Your email/)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("status").filter({ hasText: "There is a problem with Email." })).toBeVisible();
    await expect(page.locator("#cv-request-email-error")).toContainText("Enter a valid email address.");
    expect(posts).toHaveLength(0);
  });

  test("sends the request, says it was received and offers the download for a minute", async ({ page }) => {
    const problems = consoleProblems(page);
    const posts = requestPosts(page);
    await open(page);
    await fill(page);
    await requestButton(page).click();
    const sent = sentPanel(page);
    await expect(sent).toBeVisible();
    await expect(sent).toBeFocused();
    await expect(sent).toContainText(RECEIVED);
    await expect(sent).toContainText("The link works for a minute.");
    const download = sent.getByRole("link", { name: "Download the CV" });
    await expect(download).toHaveAttribute("href", /\/api\/v1\/cv\/file\//);

    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(["elapsed", "email", "name", "note", "turnstile", "website"]);
    expect(posts[0].website).toBe("");

    // The anchor downloads a PDF without leaving the page.
    const before = page.url();
    const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
    expect(page.url()).toBe(before);
    expect(problems).toEqual([]);
  });

  test("shows only the received message when the answer has no link", async ({ page }) => {
    await open(page);
    await stubPost(page, "request", 201, { detail: "Received." });
    await fill(page);
    await requestButton(page).click();
    await expect(sentPanel(page)).toContainText(RECEIVED);
    await expect(page.getByRole("link", { name: "Download the CV" })).toHaveCount(0);
    await expect(sentPanel(page)).not.toContainText("minute");
  });

  test("looks the same whatever the API says about the sender", async ({ page }) => {
    const texts: string[] = [];
    for (const body of [{}, { stored: false }, { status: "spam" }, { blocked: true, detail: "You are blocked." }]) {
      await open(page);
      await stubPost(page, "request", 201, body);
      await fill(page);
      await requestButton(page).click();
      await expect(sentPanel(page)).toBeVisible();
      texts.push(await sentPanel(page).innerText());
      await page.unroute(`${API}/api/v1/cv/request`);
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).not.toMatch(/block|spam|held/i);
  });

  test("only a link of the documented shape makes a download button", async ({ page }) => {
    await open(page);
    await stubPost(page, "request", 201, { url: "https://evil.example/cv.pdf", expires_in: 60 });
    await fill(page);
    await requestButton(page).click();
    await expect(sentPanel(page)).toContainText(RECEIVED);
    await expect(page.getByRole("link", { name: "Download the CV" })).toHaveCount(0);
  });

  test("takes the download button away when its minute is up", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await fill(page);
    await requestButton(page).click();
    await expect(page.getByRole("link", { name: "Download the CV" })).toBeVisible();
    await page.clock.fastForward(61_000);
    await expect(page.getByRole("link", { name: "Download the CV" })).toHaveCount(0);
    await expect(sentPanel(page)).toContainText("The download link has expired.");
  });

  for (const [status, headers, text] of [
    [403, {}, "Requests for the CV are not available at the moment."],
    [429, { "Retry-After": "1800" }, "try again in about 30 minutes"],
    [503, {}, "The request could not be sent right now."],
    [500, {}, "The request could not be sent. Check your connection"],
  ] as const) {
    test(`a ${status} is said in plain words, keeps what was typed and shows no raw text`, async ({ page }) => {
      await open(page);
      await stubPost(page, "request", status, { detail: "RAW API TEXT", code: "raw" }, headers);
      const values = await fill(page);
      await requestButton(page).click();
      await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
      await expect(page.locator("#cv")).not.toContainText("RAW API TEXT");
      await expect(page.getByLabel(/^Your email/)).toHaveValue(values.email);
      await expect(sentPanel(page)).toHaveCount(0);
      await expect(requestButton(page)).toBeEnabled();
    });
  }

  test("shows the API field errors by the fields", async ({ page }) => {
    await open(page);
    await stubPost(page, "request", 400, {
      detail: "Some fields need changing.",
      errors: { email: ["Enter a valid email address."], note: ["Use 500 characters or fewer."] },
    });
    await fill(page);
    await requestButton(page).click();
    await expect(page.locator("#cv-request-email-error")).toContainText("Enter a valid email address.");
    await expect(page.locator("#cv-request-note-error")).toContainText("Use 500 characters or fewer.");
    await expect(page.getByLabel(/^Your email/)).toBeFocused();
  });

  test("a failed check sends nothing and says so", async ({ page }) => {
    const posts = requestPosts(page);
    await open(page, { fail: true });
    await fill(page);
    await requestButton(page).click();
    await expect(page.getByRole("status").filter({ hasText: "The anti-spam check could not run." })).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  test("can be filled and sent with the keyboard alone, skipping the trap field", async ({ page }) => {
    await open(page);
    await page.getByLabel(/^Your name/).focus();
    await page.keyboard.type("Keyboard Tester");
    await page.keyboard.press("Tab");
    await page.keyboard.type(fresh().email);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/^Note/)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(requestButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sentPanel(page)).toContainText(RECEIVED);
  });

  test("a bot that fills the trap field is answered like anyone else", async ({ page }) => {
    await open(page);
    await fill(page);
    await page.locator("#cv-request-website").fill("https://spam.example", { force: true });
    await requestButton(page).click();
    await expect(sentPanel(page)).toContainText(RECEIVED);
  });

  test("tells the visitor about the link only when the status says one follows", async ({ page }) => {
    await stubStatus(page, { can_view: false, can_request: true, instant_download: true });
    await open(page);
    await expect(page.locator("#cv-request")).toContainText("a link to download the CV appears for a minute");
    await page.unroute(`${API}/api/v1/cv`);
    await stubStatus(page, { can_view: false, can_request: true });
    await page.reload();
    await reachCv(page);
    await expect(page.locator("#cv-request-form")).toBeVisible();
    await expect(page.locator("#cv-request")).not.toContainText("download");
  });

  test("has no accessibility violations, idle or sent", async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "the matrix runs the other browsers");
    await open(page);
    await expect(requestButton(page)).toBeVisible();
    expect((await new AxeBuilder({ page }).include("#cv").analyze()).violations).toEqual([]);
    await fill(page);
    await requestButton(page).click();
    await expect(sentPanel(page)).toBeVisible();
    expect((await new AxeBuilder({ page }).include("#cv").analyze()).violations).toEqual([]);
  });
});
