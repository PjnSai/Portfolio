import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// api/tests/e2e_server.py publishes "visitor picks" with presets A (the
// default), B and E enabled. C is a preset that is not enabled.

const A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4";
const B = "bf7b0ec6-833c-4f4c-be66-03ce086e298a";
const C = "f99b8d9e-fcd4-48cd-8a28-6d9379eae11d";
const E = "b399fb8f-5de4-462d-98f5-a81bf8046a6f";
const BG = {
  [A]: { light: "#F4F2EE", dark: "#121212" },
  [B]: { light: "#EEF1EA", dark: "#0F1410" },
  [E]: { light: "#F3EBDD", dark: "#17140F" },
};

const html = (page: Page) => page.locator("html");
const toggle = (page: Page) => page.getByRole("button", { name: "Theme" });
const colours = (page: Page) => page.getByRole("group", { name: "Colours" });
const themes = (page: Page) =>
  page.getByRole("group", { name: "Light or dark" });
const bg = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--c-bg")
      .trim(),
  );

/** Puts values in localStorage before the page's own scripts run, on the first load only. */
async function remember(page: Page, values: Record<string, string>) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [key, value] of Object.entries(entries))
      localStorage.setItem(key, value);
  }, values);
}

test("the picker lists only the enabled palettes, and a mouse click applies one", async ({
  page,
}) => {
  await page.goto("/");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

  const radios = colours(page).getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(
    colours(page).getByRole("radio", { name: "Ink and signal red" }),
  ).toBeChecked();
  await expect(
    colours(page).getByRole("radio", { name: "Oxblood and stone" }),
  ).toHaveCount(0);

  await colours(page).getByText("Original").click();
  await expect(html(page)).toHaveAttribute("data-palette", E);
  expect(await bg(page)).toBe(BG[E].light);
  await expect(page.locator("[data-display-status]")).toHaveText(
    "Colours: Original",
  );
});

test("the choice is remembered after a reload and on other pages", async ({
  page,
}) => {
  await page.goto("/");
  await toggle(page).click();
  await colours(page).getByText("Forest green and ink").click();

  await page.reload();
  await expect(html(page)).toHaveAttribute("data-palette", B);
  await toggle(page).click();
  await expect(
    colours(page).getByRole("radio", { name: "Forest green and ink" }),
  ).toBeChecked();

  await page.goto("/projects");
  await expect(html(page)).toHaveAttribute("data-palette", B);
});

test("the picker works by keyboard and Escape returns focus to the button", async ({
  page,
}) => {
  await page.goto("/");
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(themes(page)).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(
    themes(page).getByRole("radio", { name: "Match my device" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    colours(page).getByRole("radio", { name: "Ink and signal red" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    colours(page).getByRole("radio", { name: "Forest green and ink" }),
  ).toBeChecked();
  await expect(html(page)).toHaveAttribute("data-palette", B);

  await page.keyboard.press("Escape");
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(themes(page)).toBeHidden();
});

test("every option is at least 44 px tall", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  const boxes = [
    toggle(page),
    ...(await page.locator(".display__option").all()),
  ];
  for (const box of boxes)
    expect((await box.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("a remembered palette that is no longer enabled falls back to the default", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await remember(page, { palette: C });

  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-palette", A);
  await toggle(page).click();
  await expect(
    colours(page).getByRole("radio", { name: "Ink and signal red" }),
  ).toBeChecked();
  expect(errors).toEqual([]);
});

test.describe("light and dark", () => {
  test("follows the device by default", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(html(page)).toHaveAttribute("data-theme", "system");
    expect(await bg(page)).toBe(BG[A].dark);
    await page.emulateMedia({ colorScheme: "light" });
    expect(await bg(page)).toBe(BG[A].light);
  });

  test("light and dark override the device, are remembered, and work with each palette", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await toggle(page).click();
    await themes(page)
      .getByRole("radio", { name: "Light", exact: true })
      .click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    expect(await bg(page)).toBe(BG[A].light);
    await expect(page.locator("[data-display-status]")).toHaveText(
      "Theme: Light",
    );

    await page.emulateMedia({ colorScheme: "light" });
    await themes(page)
      .getByRole("radio", { name: "Dark", exact: true })
      .click();
    for (const id of [A, B, E] as const) {
      await page.evaluate((value) => {
        document
          .querySelector<HTMLInputElement>(
            `input[name="palette"][value="${value}"]`,
          )
          ?.click();
      }, id);
      await expect(html(page)).toHaveAttribute("data-palette", id);
      expect(await bg(page)).toBe(BG[id].dark);
    }

    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await bg(page)).toBe(BG[E].dark);
  });

  test("going back to the device setting forgets the override", async ({
    page,
  }) => {
    await remember(page, { theme: "dark" });
    await page.goto("/");
    await toggle(page).click();
    await themes(page).getByRole("radio", { name: "Match my device" }).click();

    await expect(html(page)).toHaveAttribute("data-theme", "system");
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();
    await page.reload();
    expect(await bg(page)).toBe(BG[A].light);
  });
});

test("the boot script is inline in <head>, so it runs before the body is parsed", async ({
  request,
}) => {
  const text = await (await request.get("/")).text();
  const script = text.indexOf("<script>(function(){");
  expect(script).toBeGreaterThan(text.indexOf("<head>"));
  expect(script).toBeLessThan(text.indexOf("</head>"));
  // Any script before it is an async file, which cannot hold up or colour the page.
  const before = text.slice(0, script).match(/<script[^>]*>/gi) ?? [];
  for (const tag of before)
    expect(tag).toMatch(/\ssrc="[^"]+"[^>]*\sasync=""|\sasync=""[^>]*\ssrc=/);
});

test("theme and palette are set before the body exists, so nothing flashes", async ({
  page,
}) => {
  await remember(page, { theme: "dark", palette: E });
  await page.addInitScript(() => {
    const seen: Record<string, string | undefined>[] = [];
    (window as unknown as { seenAtBody: typeof seen }).seenAtBody = seen;
    new MutationObserver((records, observer) => {
      if (!document.body) return;
      const root = document.documentElement;
      seen.push({
        theme: root.dataset.theme,
        palette: root.dataset.palette,
        bg: getComputedStyle(root).getPropertyValue("--c-bg").trim(),
      });
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto("/");
  const seen = await page.evaluate(
    () => (window as unknown as { seenAtBody: unknown[] }).seenAtBody,
  );
  expect(seen).toEqual([{ theme: "dark", palette: E, bg: BG[E].dark }]);
});

test("a fixed-mode site shows no palette picker and ignores a remembered palette", async ({
  page,
}) => {
  // The built site is in "visitor picks" mode; this serves its home page as a
  // fixed-mode build would mark it. Nothing else in the page changes.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        'data-palette-mode="pick"',
        'data-palette-mode="fixed"',
      );
      await route.fulfill({ response, body });
    },
  );
  await remember(page, { palette: E });

  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-palette-mode", "fixed");
  await expect(html(page)).toHaveAttribute("data-palette", A);
  await toggle(page).click();
  await expect(themes(page).getByRole("radio")).toHaveCount(3);
  await expect(colours(page)).toHaveCount(0);
  await expect(page.locator('input[name="palette"]')).toHaveCount(0);
});

test("without JavaScript there is no theme menu and the device setting applies", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(toggle(page)).toBeHidden();
  expect(await bg(page)).toBe(BG[A].dark);
  await context.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing on home with the picker open (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await toggle(page).click();
    await expect(colours(page)).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      result.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
}
