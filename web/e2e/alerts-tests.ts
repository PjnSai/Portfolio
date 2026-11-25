import { expect, type Locator, type Page, test } from "@playwright/test";

// The alerts page and the unseen count on the navigation, inside admin.spec.ts
// after the owner has signed in. The API's test server seeds two unseen alerts
// (a rate-limit storm and, older, a server-error spike), one seen one, and 22
// older seen ones, so the list has a second page. Other browser tests may raise
// alerts of their own, so counts are compared before and after, never fixed.

const PAGE = "/desk/alerts";
const STORM = "100 requests refused by a rate limit in 10 minutes.";
const SPIKE = "20 server errors in 5 minutes (keyboard test).";

const rows = (page: Page) => page.getByTestId("alert");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const count = async (page: Page) => {
  const badge = page.getByTestId("alerts-count");
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.first().locator("[aria-hidden]").innerText()).trim());
};
const main = (page: Page) => page.locator("main");
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

async function loaded(page: Page) {
  await page.goto(PAGE);
  await expect(rows(page).first()).toBeVisible();
}

export function alertsTests(getPage: () => Page) {
  test.describe("alerts", () => {
    test.describe.configure({ mode: "serial" });

    test("is in the navigation with the unseen count, and says where alerts live", async () => {
      const page = getPage();
      await page.goto("/desk/sections");
      const link = page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: /^Alerts/ });
      await expect(link.getByTestId("alerts-count")).toBeVisible();
      expect(await count(page)).toBeGreaterThanOrEqual(2);
      await expect(link).toContainText("unseen");
      await link.click();
      await expect(page).toHaveURL(/\/desk\/alerts$/);
      await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
      await expect(link).toHaveAttribute("aria-current", "page");
      await expect(main(page)).toContainText("only in this admin");
      await expect(main(page)).toContainText("A notice outside the site is separate");
    });

    test("lists newest first with time, kind in words and summary, 20 at a time", async () => {
      const page = getPage();
      await loaded(page);
      await expect(rows(page)).toHaveCount(20);
      const times = await rows(page).locator("time").evaluateAll((all) =>
        all.map((each) => Date.parse(each.getAttribute("datetime") ?? "")),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
      await expect(row(page, STORM)).toContainText("Many requests turned away");
      await expect(row(page, STORM)).toContainText("Unseen");
      expect(await main(page).innerText()).not.toMatch(/rate_limit_storm|error_spike|failed_sign_ins/);

      const older = page.getByRole("button", { name: "Show older alerts" });
      while (await older.isVisible()) {
        const before = await rows(page).count();
        await older.click();
        await expect.poll(() => rows(page).count()).toBeGreaterThan(before);
      }
      await expect(row(page, "older alert 22")).toBeVisible();
      await expect(row(page, "5 failed sign-ins")).toContainText("Seen");
      await expect(row(page, "5 failed sign-ins").getByRole("button", { name: "Mark seen" })).toHaveCount(0);
    });

    test("Unseen only hides the seen ones", async () => {
      const page = getPage();
      await loaded(page);
      await page.getByLabel("Unseen only").check();
      await expect(page.getByRole("heading", { level: 2, name: /Unseen alerts/ })).toBeVisible();
      await expect(row(page, STORM)).toBeVisible();
      await expect(row(page, "5 failed sign-ins")).toHaveCount(0);
      for (const each of await rows(page).all()) await expect(each).toHaveAttribute("data-seen", "false");
      await page.getByLabel("Unseen only").uncheck();
      await expect(page.locator('[data-testid="alert"][data-seen="true"]').first()).toBeVisible();
    });

    test("Mark seen in the unseen view removes the alert, lowers the navigation count and keeps focus", async () => {
      const page = getPage();
      await loaded(page);
      await page.getByLabel("Unseen only").check();
      await expect(row(page, STORM)).toBeVisible();
      const before = await count(page);
      expect(before).toBeGreaterThanOrEqual(2);
      const request = page.waitForRequest((r) => r.method() === "POST" && /\/alerts\/[0-9a-f-]{36}\/seen$/.test(r.url()));
      await row(page, STORM).getByRole("button", { name: "Mark seen" }).click();
      await request;
      await expect(row(page, STORM)).toHaveCount(0);
      await expect(main(page).getByRole("status")).toContainText("Marked as seen");
      await expect.poll(() => count(page)).toBe(before - 1);
      // Focus did not fall back to the page: it is on a waiting alert or the heading.
      await expect.poll(() => focusedId(page)).toMatch(/^(alert-[0-9a-f-]{36}|alerts-heading)$/);
      // The server agrees: a fresh load still has it seen.
      await page.reload();
      await expect(rows(page).first()).toBeVisible();
      await expect(row(page, STORM)).toContainText("Seen");
      expect(await count(page)).toBe(before - 1);
    });

    test("by keyboard: Tab to Mark seen, Enter, and focus stays on that alert", async () => {
      const page = getPage();
      await loaded(page);
      const target = row(page, SPIKE);
      await expect(target).toContainText("Unseen");
      const id = (await target.getAttribute("id")) ?? "";
      const before = await count(page);
      const button = target.getByRole("button", { name: "Mark seen" });
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(target).toContainText("Seen");
      await expect(target.getByRole("button", { name: "Mark seen" })).toHaveCount(0);
      await expect.poll(() => focusedId(page)).toBe(id);
      await expect.poll(() => count(page)).toBe(before - 1);
    });

    test("an API failure shows an error, never an empty list", async () => {
      const page = getPage();
      await page.route("**/api/v1/admin/alerts*", (route) => route.fulfill({ status: 500, body: "{}" }));
      await page.goto(PAGE);
      await expect(main(page).getByRole("alert")).toContainText("Something went wrong");
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByTestId("alerts-empty")).toHaveCount(0);
      // The navigation count could not be read either, and says so rather than showing none.
      await expect(page.getByTestId("alerts-count")).toContainText("?");
      await page.unroute("**/api/v1/admin/alerts*");

      await page.route("**/api/v1/admin/alerts*", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
      );
      await page.goto(PAGE);
      await expect(main(page).getByRole("alert")).toContainText("not what this page expected");
      await expect(page.getByTestId("alerts-empty")).toHaveCount(0);
      await page.unroute("**/api/v1/admin/alerts*");
    });

    test("a failed Mark seen says so and leaves the alert unseen", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await page.getByLabel("Unseen only").check();
      await expect(rows(page).first()).toBeVisible();
      const first: Locator = rows(page).first();
      await page.route("**/api/v1/admin/alerts/*/seen", (route) => route.fulfill({ status: 500, body: "{}" }));
      await first.getByRole("button", { name: "Mark seen" }).click();
      await expect(main(page).getByRole("alert")).toContainText("Something went wrong");
      await expect(first).toContainText("Unseen");
      await expect(first.getByRole("button", { name: "Mark seen" })).toBeEnabled();
      await page.unroute("**/api/v1/admin/alerts/*/seen");
    });

    test("fits a phone screen", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await loaded(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 720 });
    });
  });
}
