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

test("fonts are served by the site, never fetched from Google", async ({ page }) => {
  const elsewhere: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "localhost") elsewhere.push(url.hostname);
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.fonts, (font) => font.family);
  });

  expect(elsewhere).toEqual([]);
  expect(fonts.join(" ")).toMatch(/Instrument Sans/);
});
