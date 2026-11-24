import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { API } from "../e2e/fixtures/contact";
import type { Combo } from "../playwright.matrix.config";

// The owner's inbox in every browser, width, colour scheme and motion setting.
// A virtual passkey works in Chromium only, so these pages are opened with a
// session the e2e API makes at start (api/tests/e2e_server.py): its token is
// in a file, and is sent as the cookie a sign-in would set.
// Reading and opening only: nothing here changes a message.

const combo = () => test.info().project.metadata as Combo;
const read = (name: string) =>
  readFileSync(resolve(__dirname, "../../api", name), "utf8").trim();

test.beforeEach(async ({ context }) => {
  test.skip(!combo().js, "the owner's pages need JavaScript");
  // In production Cloudflare Access adds its header at the edge.
  const access = read(".e2e-access-token");
  await context.route(`${API}/**`, (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        "cf-access-jwt-assertion": access,
      },
    }),
  );
  // The cookie a sign-in sets. Cookies ignore the port, so one for localhost
  // reaches the API on its own port.
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

const noSidewaysScroll = async (page: Page, label: string) => {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, label).toBeLessThanOrEqual(client);
};

const rows = (page: Page) => page.getByTestId("message-row");

test("the list, its filters and its folders fit the screen", async ({
  page,
}) => {
  await page.goto("/desk/messages");
  await expect(
    page.getByRole("heading", { level: 1, name: "Messages" }),
  ).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Message folders" }),
  ).toBeVisible();
  await expect(
    page.getByRole("search", { name: "Search and filter messages" }),
  ).toBeVisible();
  await expect(rows(page).first()).toContainText("Unverified");
  await noSidewaysScroll(page, "list");

  await page.getByRole("link", { name: /^Spam/ }).click();
  await expect(page).toHaveURL(/status=spam/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Spam score 100 of 100");
  await noSidewaysScroll(page, "spam folder");
});

test("a message opens, with a long name, a long address and an unbroken word, and fits", async ({
  page,
}) => {
  await page.goto("/desk/messages");
  await page.getByRole("link", { name: /Matrix Sender Two/ }).click();

  const heading = page.getByRole("heading", {
    level: 2,
    name: /^Message from Matrix Sender Two/,
  });
  await expect(heading).toBeFocused();
  await expect(page.getByText("Email (UNVERIFIED)")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Reply by email" }),
  ).toBeVisible();
  await expect(page.getByText("And a second paragraph")).toBeVisible();
  await noSidewaysScroll(page, "message");
});

test("asking to delete shows the question, keeps focus in it, and Escape closes it", async ({
  page,
}) => {
  await page.goto("/desk/messages");
  await page.getByRole("link", { name: /Matrix Sender One/ }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: /^Message from Matrix Sender One/,
    }),
  ).toBeFocused();

  const ask = page.getByRole("button", { name: "Delete for good" });
  await ask.click();
  const group = page.getByRole("group", {
    name: "Delete this message for good?",
  });
  await expect(group).toBeVisible();
  await expect(group).toContainText("24 hours");
  await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();
  await noSidewaysScroll(page, "delete question");

  await page.keyboard.press("Escape");
  await expect(group).toHaveCount(0);
  await expect(ask).toBeFocused();
  await noSidewaysScroll(page, "after Escape");
});

test("a held-back message offers Not spam and no reply", async ({ page }) => {
  await page.goto("/desk/messages?status=spam");
  await rows(page).first().getByRole("link").click();

  await expect(page.getByRole("button", { name: "Not spam" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reply by email" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("held back by the spam checks").first(),
  ).toBeVisible();
  await noSidewaysScroll(page, "held-back message");
});
