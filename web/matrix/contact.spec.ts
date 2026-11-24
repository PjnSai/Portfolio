import { expect, type Page, test } from "@playwright/test";
import { API } from "../e2e/fixtures/contact";
import { stubTurnstile, withAddress } from "../e2e/fixtures/form";
import type { Combo } from "../playwright.matrix.config";

// The contact form in every browser, width, colour scheme and motion setting,
// and with JavaScript off. The API's answer is a stand-in (the daily cap on
// real messages is 25, and this matrix has dozens of projects); the real
// route is covered by e2e/contact.spec.ts.

const combo = () => test.info().project.metadata as Combo;
const FORM = "[data-contact-form]";

async function stubSend(page: Page) {
  await page.route(`${API}/api/v1/contact`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 201,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "http://localhost:3100" },
          body: JSON.stringify({
            detail: "Thank you. Your message has been received.",
          }),
        })
      : route.fallback(),
  );
}

const noSidewaysScroll = async (page: Page, label: string) => {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, label).toBeLessThanOrEqual(client);
};

const sectionHeight = (page: Page) =>
  page
    .locator(".section--contact")
    .evaluate((el) => (el as HTMLElement).offsetHeight);

test("with JavaScript off the form is hidden and the page says why", async ({
  page,
}) => {
  test.skip(combo().js, "JavaScript is on in this project");
  await page.goto("/");

  const note = page.locator(`${FORM} noscript p.contact-note`);
  await expect(note).toBeVisible();
  await expect(note).toContainText("needs JavaScript");
  await expect(page.getByLabel(/^Name/)).toBeHidden();
  await expect(page.getByRole("button", { name: "Send message" })).toBeHidden();
  expect(await page.locator(".section--contact").innerText()).not.toMatch(
    /[\w.+-]+@[\w-]+\.[\w.]+/,
  );
  await noSidewaysScroll(page, "no JavaScript");
});

test("the form shows its problems, then sends, without moving the page or scrolling sideways", async ({
  page,
}) => {
  test.skip(!combo().js, "needs JavaScript");
  await stubTurnstile(page);
  await withAddress(page);
  await stubSend(page);
  await page.goto("/");
  await page.locator(FORM).scrollIntoViewIfNeeded();
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeEnabled();
  await noSidewaysScroll(page, "form at rest");
  const before = await sectionHeight(page);

  await send.click();
  await expect(page.locator("#contact-name-error")).toHaveText(
    "Error: Enter your name.",
  );
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "There are 3 problems" }),
  ).toBeVisible();
  await noSidewaysScroll(page, "form with problems");
  expect(await sectionHeight(page), "problems").toBe(before);

  await page.getByLabel(/^Name/).fill("Matrix Tester");
  await page.getByLabel(/^Email/).fill("matrix.tester@example.com");
  await page.getByLabel(/^Reason/).selectOption("hiring");
  await page
    .getByLabel(/^Message/)
    .fill("A message from the browser matrix, long enough to send.");
  await send.click();
  const sent = page.locator("#contact-sent");
  await expect(sent).toBeVisible();
  await expect(sent).toBeFocused();
  await noSidewaysScroll(page, "form sent");
  expect(await sectionHeight(page), "sent").toBe(before);
});

test("the form fits and stays readable on a very long message and name", async ({
  page,
}) => {
  test.skip(!combo().js, "needs JavaScript");
  await stubTurnstile(page);
  await withAddress(page);
  await page.goto("/");
  await page.locator(FORM).scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();

  await page.getByLabel(/^Name/).fill("N".repeat(100));
  await page
    .getByLabel(/^Email/)
    .fill(`${"e".repeat(60)}@${"d".repeat(60)}.example`);
  await page.getByLabel(/^Message/).fill("w".repeat(500));

  await noSidewaysScroll(page, "long values");
});
