import { expect, type Page, test } from "@playwright/test";

// The abuse overview, inside admin.spec.ts after the owner has signed in. The
// API's test server seeds counts only on days before today (the other browser
// tests add to today's row): spam 2 and turnstile_failed 4 three days ago, spam
// 1 five days ago, and rate_limited 6 forty days ago.

const PAGE = "/desk/abuse";
const DAY_MS = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);

const total = (page: Page, kind: string) => page.getByTestId(`abuse-total-${kind}`).locator("td").first();

async function choose(page: Page, from: string, to: string, kind = "") {
  await page.getByLabel("From", { exact: true }).fill(from);
  await page.getByLabel("To", { exact: true }).fill(to);
  await page.getByLabel("Kind", { exact: true }).selectOption(kind);
  await page.getByRole("button", { name: "Show" }).click();
}

export function abuseTests(getPage: () => Page) {
  test.describe("abuse overview", () => {
    test.describe.configure({ mode: "serial" });

    test("is in the navigation, defaults to the last 30 days and says it holds counts only", async () => {
      const page = getPage();
      await page.goto("/desk/sections");
      await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Abuse", exact: true }).click();
      await expect(page).toHaveURL(/\/desk\/abuse$/);
      await expect(page.getByRole("heading", { level: 1, name: "Abuse overview" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Abuse", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByText(/counts only/)).toContainText("no addresses");
      await expect(page.getByLabel("From", { exact: true })).toHaveValue(iso(29));
      await expect(page.getByLabel("To", { exact: true })).toHaveValue(iso(0));
      await expect(page.getByTestId("abuse-day")).toHaveCount(30);
      // The 40-day-old count is outside the default range.
      await expect(total(page, "rate_limited")).toHaveText("0");
    });

    test("totals and the day table match the seeded counts, with words for every kind", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await choose(page, iso(60), iso(1));
      await expect(page.getByTestId("abuse-day")).toHaveCount(60);
      await expect(total(page, "spam")).toHaveText("3");
      await expect(total(page, "turnstile_failed")).toHaveText("4");
      await expect(total(page, "rate_limited")).toHaveText("6");
      await expect(total(page, "login_failed")).toHaveText("0");
      await expect(page.getByTestId("abuse-total-all")).toHaveText("13");
      await expect(page.getByTestId("abuse-totals").locator("tbody tr")).toHaveCount(12);
      const text = await page.getByTestId("abuse-totals").innerText();
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
      for (const label of ["Too many requests", "Human check failed", "Held back as spam", "Refused at the door"]) {
        expect(text).toContain(label);
      }
      // Oldest first: day k days ago is row 60 - k.
      const three = page.getByTestId("abuse-day").nth(57);
      await expect(three).toContainText("6");
      await expect(three).toContainText("Human check failed 4, Held back as spam 2");
      await expect(page.getByTestId("abuse-day").last()).toContainText("None");
    });

    test("the kind filter shows one kind, and the range filter changes the days", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await choose(page, iso(60), iso(1), "spam");
      await expect(page.getByTestId("abuse-totals").locator("tbody tr")).toHaveCount(2);
      await expect(total(page, "spam")).toHaveText("3");
      await expect(page.getByTestId("abuse-total-all")).toHaveText("3");
      await expect(page.getByTestId("abuse-total-rate_limited")).toHaveCount(0);

      await choose(page, iso(10), iso(1), "");
      await expect(page.getByTestId("abuse-day")).toHaveCount(10);
      await expect(total(page, "rate_limited")).toHaveText("0");
      await expect(total(page, "spam")).toHaveText("3");
    });

    test("a range the API would refuse is stopped here with a message, and the form works by keyboard", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await choose(page, iso(1), iso(10));
      await expect(page.locator("main").getByRole("alert")).toContainText("must be before the end date");
      await choose(page, iso(400), iso(0));
      await expect(page.locator("main").getByRole("alert")).toContainText("at most 366 days");

      await page.getByLabel("From", { exact: true }).fill(iso(8));
      await page.getByLabel("To", { exact: true }).fill(iso(1));
      await page.getByLabel("To", { exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
      await expect(page.getByTestId("abuse-day")).toHaveCount(8);
    });

    test("an API failure shows an error, never empty totals", async () => {
      const page = getPage();
      await page.route("**/api/v1/admin/abuse*", (route) => route.fulfill({ status: 500, body: "{}" }));
      await page.goto(PAGE);
      await expect(page.locator("main").getByRole("alert")).toContainText("Something went wrong");
      await expect(page.getByTestId("abuse-totals")).toHaveCount(0);
      await page.unroute("**/api/v1/admin/abuse*");

      await page.route("**/api/v1/admin/abuse*", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
      );
      await page.goto(PAGE);
      await expect(page.locator("main").getByRole("alert")).toContainText("not what this page expected");
      await expect(page.getByTestId("abuse-totals")).toHaveCount(0);
      await page.unroute("**/api/v1/admin/abuse*");
    });

    test("fits a phone screen", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE);
      await expect(page.getByTestId("abuse-totals")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 720 });
    });
  });
}
