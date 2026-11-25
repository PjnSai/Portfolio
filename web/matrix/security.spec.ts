import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { API } from "../e2e/fixtures/contact";
import { settled } from "../e2e/fixtures/settled";
import type { Combo } from "../playwright.matrix.config";

// The abuse overview, alerts and access review pages in every browser, width,
// colour scheme and motion setting, opened with the session the e2e API makes at
// start, as the inbox and CV matrices do. Reading and opening only: nothing here
// marks an alert seen. axe runs in every browser, Firefox too; a crash there is
// reported as it is, not skipped.

const combo = () => test.info().project.metadata as Combo;
const read = (name: string) => readFileSync(resolve(__dirname, "../../api", name), "utf8").trim();

const noSidewaysScroll = async (page: Page, label: string) => {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, label).toBeLessThanOrEqual(client);
};

test.beforeEach(async ({ context }) => {
  test.skip(!combo().js, "the owner's pages need JavaScript");
  const access = read(".e2e-access-token");
  await context.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-access-jwt-assertion": access } }),
  );
  await context.addCookies([
    {
      name: "__Host-session",
      value: read(".e2e-session-token"),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: combo().browser === "chromium",
      sameSite: "Strict",
    },
  ]);
});

async function check(page: Page, label: string) {
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await settled(page);
  await noSidewaysScroll(page, label);
  if (![390, 1280].includes(combo().width)) return;
  expect((await new AxeBuilder({ page }).analyze()).violations, label).toEqual([]);
}

test("the abuse overview: filters, totals and the day table", async ({ page }) => {
  await page.goto("/desk/abuse");
  await expect(page.getByRole("heading", { level: 1, name: "Abuse overview" })).toBeVisible();
  await expect(page.getByTestId("abuse-totals")).toBeVisible();
  await expect(page.getByTestId("abuse-day")).toHaveCount(30);
  await expect(page.getByLabel("Kind", { exact: true })).toBeVisible();
  await check(page, "abuse");
});

test("the abuse overview with a range and one kind", async ({ page }) => {
  await page.goto("/desk/abuse");
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("From", { exact: true }).fill(day(60));
  await page.getByLabel("To", { exact: true }).fill(day(1));
  await page.getByLabel("Kind", { exact: true }).selectOption("spam");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("abuse-day")).toHaveCount(60);
  await check(page, "abuse, one kind");
});

test("the alerts list", async ({ page }) => {
  await page.goto("/desk/alerts");
  await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
  await expect(page.getByTestId("alert").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Show older alerts" })).toBeVisible();
  await expect(page.getByTestId("alerts-count").first()).toBeVisible();
  await check(page, "alerts");
});

test("the alerts list, unseen only", async ({ page }) => {
  await page.goto("/desk/alerts");
  await expect(page.getByTestId("alert").first()).toBeVisible();
  await page.getByLabel("Unseen only").check();
  await expect(page.getByRole("heading", { level: 2, name: /Unseen alerts/ })).toBeVisible();
  await check(page, "alerts, unseen only");
});

test("the access review", async ({ page }) => {
  await page.goto("/desk/access");
  await expect(page.getByRole("heading", { level: 1, name: "Access review" })).toBeVisible();
  await expect(page.getByTestId("principal")).toHaveCount(9);
  await expect(page.getByRole("alert").filter({ hasText: "superuser" }).first()).toBeVisible();
  await expect(page.getByText("Not checked by the app", { exact: true })).toHaveCount(2);
  await check(page, "access");
});
