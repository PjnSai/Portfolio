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
