import { expect, test } from "@playwright/test";

test("home page renders without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Pujan Shahi",
  );
  await context.close();
});

test("healthz responds", async ({ request }) => {
  const response = await request.get("/healthz");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
