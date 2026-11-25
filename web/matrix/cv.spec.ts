import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { API } from "../e2e/fixtures/contact";
import { reachCv, stubPost, withCvAddress } from "../e2e/fixtures/cv";
import { stubTurnstile } from "../e2e/fixtures/form";
import { settled } from "../e2e/fixtures/settled";
import type { Combo } from "../playwright.matrix.config";

// The CV in every browser, width, colour scheme and motion setting: the public
// viewer and request form (the file comes from the real API, the request is a
// stand-in because of the daily cap on real messages) and the owner's CV page,
// opened with the session the e2e API makes at start, as the inbox matrix does.
// Reading and opening only. axe runs in every browser, Firefox too; a crash
// there is reported as it is, not skipped.

const combo = () => test.info().project.metadata as Combo;
const read = (name: string) => readFileSync(resolve(__dirname, "../../api", name), "utf8").trim();

const noSidewaysScroll = async (page: Page, label: string) => {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, label).toBeLessThanOrEqual(client);
};

test("with JavaScript off the page says nothing about a CV", async ({ page }) => {
  test.skip(combo().js, "JavaScript is on in this project");
  await page.goto("/");
  await expect(page.locator("[data-cv-root]")).toBeEmpty();
  expect(await page.locator("main").innerText()).not.toMatch(/\bCV\b/);
  await noSidewaysScroll(page, "no JavaScript");
});

test.describe("the public CV", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!combo().js, "needs JavaScript");
    await stubTurnstile(page);
    await withCvAddress(page);
    await stubPost(page, "request", 201, { detail: "Thank you." });
    await page.goto("/");
    await reachCv(page);
  });

  test("the block, the request form and its answer fit the screen and have no violations", async ({ page }) => {
    await expect(page.getByRole("button", { name: "View the CV" })).toBeEnabled();
    await settled(page);
    await noSidewaysScroll(page, "block");
    expect((await new AxeBuilder({ page }).include("#cv").analyze()).violations, "block").toEqual([]);

    await page.getByRole("button", { name: "Request a copy" }).click();
    await expect(page.locator("#cv-request-email-error")).toHaveText("Error: Enter a valid email address.");
    await expect(page.getByLabel(/^Your email/)).toBeFocused();
    await noSidewaysScroll(page, "problems");
    expect((await new AxeBuilder({ page }).include("#cv").analyze()).violations, "problems").toEqual([]);

    await page.getByLabel(/^Your email/).fill("matrix@example.com");
    await page.getByRole("button", { name: "Request a copy" }).click();
    await expect(page.locator("#cv-request-sent")).toContainText("Thank you. Your message has been received.");
    await noSidewaysScroll(page, "received");
    expect((await new AxeBuilder({ page }).include("#cv").analyze()).violations, "received").toEqual([]);
  });

  test("the viewer opens, fits the screen, closes with Escape and has no violations", async ({ page }) => {
    await page.getByRole("button", { name: "View the CV" }).click();
    const dialog = page.locator("dialog.cv-viewer");
    await expect(dialog.getByRole("img")).toHaveCount(2);
    await settled(page);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(combo().width);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
    await noSidewaysScroll(page, "viewer");
    expect((await new AxeBuilder({ page }).include("dialog.cv-viewer").analyze()).violations, "viewer").toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "View the CV" })).toBeFocused();
  });
});

test.describe("the owner's CV page", () => {
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

  test("the switches, versions and views fit the screen and have no violations", async ({ page }) => {
    await page.goto("/desk/cv");
    await expect(page.getByRole("heading", { level: 1, name: "CV" })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Viewing/ })).toBeVisible();
    await expect(page.getByTestId("cv-version").first()).toBeVisible();
    await expect(page.getByLabel(/Choose a PDF/)).toBeVisible();
    await noSidewaysScroll(page, "cv page");
    if (![390, 1280].includes(combo().width)) return;
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations, "cv page").toEqual([]);
  });
});
