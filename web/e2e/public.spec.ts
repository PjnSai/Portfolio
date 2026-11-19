import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The site is built from the sections api/tests/e2e_server.py publishes:
// a hero, About me, Selected work (eight projects), Work history, Study (empty),
// Toolkit, Contact me and Elsewhere (folded into Contact me).

const PRESET_A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4";
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const pager = (page: Page) => page.getByRole("navigation", { name: "Sections" });
const burger = (page: Page) => nav(page).getByRole("button", { name: "Menu" });

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("the published default palette is on <html> and its slots are tokens", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-palette", PRESET_A);
  const bg = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-bg").trim());
  expect(await bg()).toBe("#F4F2EE");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg()).toBe("#121212");
});

test("prerendered pages carry no style attributes (the policy allows none)", async ({ request }) => {
  for (const path of ["/", "/projects", "/projects/page/2", "/projects/task-board"]) {
    expect(await (await request.get(path)).text(), path).not.toMatch(/\sstyle=/);
  }
});

test("one h1, headings in order, and every section from the API in order", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveCount(1);
  const levels = await page.locator("h1, h2, h3, h4").evaluateAll((all) =>
    all.map((h) => Number(h.tagName[1])),
  );
  for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  await expect(page.locator("main h2")).toHaveText([
    "About me",
    "Selected work",
    "Work history",
    "Study",
    "Toolkit",
    "Contact me",
  ]);
  await expect(page.getByText("01 / About")).toBeVisible();
  await expect(page.getByRole("link", { name: "GitHub" })).toBeVisible();
});

test("empty sections and missing images show placeholders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#education")).toContainText("TODO: add education.");
  await expect(page.locator(".portrait")).toContainText("TODO: portrait");
  await expect(page.locator("#projects")).toContainText("TODO: screenshot");
});

test("the skip link is first and moves focus to the main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("a nav link jumps to its section, focuses the heading and marks itself current", async ({
    page,
  }) => {
    await page.goto("/");
    const link = nav(page).getByRole("link", { name: "Projects", exact: true });
    await link.click();
    await expect(page).toHaveURL(/#projects$/);
    await expect(page.getByRole("heading", { level: 2, name: "Selected work" })).toBeFocused();
    await expect(link).toHaveAttribute("aria-current", "location");
    await expect(pager(page).getByRole("link", { name: "Go to Projects" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    await expect(nav(page).getByRole("link", { name: "About", exact: true })).not.toHaveAttribute(
      "aria-current",
      /.+/,
    );
    const heading = await page.getByRole("heading", { level: 2, name: "Selected work" }).boundingBox();
    expect(heading!.y).toBeGreaterThanOrEqual(56);
  });

  test("Get in touch jumps to the contact section", async ({ page }) => {
    await page.goto("/");
    await page.locator(".nav").getByRole("link", { name: "Get in touch" }).click();
    await expect(page).toHaveURL(/#contact$/);
    await expect(page.getByRole("heading", { level: 2, name: "Contact me" })).toBeFocused();
  });

  test("the section pager shows over 1000 px with labelled links", async ({ page }) => {
    await page.goto("/");
    await expect(pager(page)).toBeVisible();
    await expect(pager(page).getByRole("link")).toHaveCount(6);
    await expect(burger(page)).toBeHidden();
  });

  test("hover lift has a keyboard equivalent on cards", async ({ page }) => {
    await page.goto("/");
    const card = page.locator(".card").first();
    await card.getByRole("link").focus();
    const transform = await card.evaluate((el) => getComputedStyle(el).transform);
    expect(transform).not.toBe("none");
  });
});

for (const width of [760, 999]) {
  test(`no section pager at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(pager(page)).toBeHidden();
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the burger opens and closes by keyboard and Escape returns focus to it", async ({ page }) => {
    await page.goto("/");
    const menu = page.locator("#site-menu");
    await expect(burger(page)).toBeVisible();
    await expect(burger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    const box = await burger(page).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);

    await burger(page).focus();
    await page.keyboard.press("Enter");
    await expect(burger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("link").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(burger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await expect(burger(page)).toBeFocused();

    await page.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "Experience", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/#experience$/);
    await expect(page.getByRole("heading", { level: 2, name: "Work history" })).toBeFocused();
  });

  test("tabbing past the open menu closes it, so focus never sits in a hidden list", async ({
    page,
  }) => {
    await page.goto("/");
    await burger(page).click();
    const links = page.locator("#site-menu a");
    await links.last().focus();
    await page.keyboard.press("Tab");
    await expect(burger(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("no pager and the hero stacks with the photo below the text", async ({ page }) => {
    await page.goto("/");
    await expect(pager(page)).toBeHidden();
    const name = await page.locator("h1").boundingBox();
    const photo = await page.locator(".portrait").boundingBox();
    expect(photo!.y).toBeGreaterThan(name!.y + name!.height);
  });
});

test("without JavaScript the nav links show on a phone and no burger appears", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: PHONE });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#site-menu")).toBeVisible();
  await expect(page.locator(".nav__burger")).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: "Selected work" })).toBeVisible();
  await context.close();
});

test("scroll snapping is off when the viewport is under 500 px tall", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto("/");
  const snap = () => page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType);
  expect(await snap()).toBe("none");
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await snap()).toMatch(/^y( proximity)?$/);
});

for (const width of [320, 360, 390, 768, 1024, 1280, 1920]) {
  test(`no horizontal scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/projects", "/projects/page/2", "/projects/task-board"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
}

test("/projects lists the first six projects and links to each case study", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Projects");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Task board",
    "Log parser",
    "Seeded project 3",
    "Seeded project 4",
    "Seeded project 5",
    "Seeded project 6",
  ]);
  await page.getByRole("link", { name: "Task board" }).click();
  await expect(page).toHaveURL(/\/projects\/task-board$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Task board");
  await expect(page.getByText("What I built")).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Problem" })).toBeVisible();
});

test("a project keeps the address it was first published under", async ({ page, request }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "Seeded project 3" }).click();
  await expect(page).toHaveURL(/\/projects\/first-seeded-project$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Seeded project 3");
  expect((await request.get("/projects/seeded-project-3")).status()).toBe(404);
});

test("a case study with deep headings never skips a level", async ({ page }) => {
  await page.goto("/projects/log-parser");
  const levels = await page
    .locator("main")
    .evaluate((main) => Array.from(main.querySelectorAll("h1, h2, h3, h4, h5, h6"), (h) => Number(h.tagName[1])));
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i += 1) expect(levels[i], `heading ${i}`).toBeLessThanOrEqual(levels[i - 1] + 1);
  await expect(page.getByRole("heading", { level: 3, name: "Approach" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4, name: "Parsing" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 5, name: "Edge cases" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Outcome" })).toBeVisible();
  const order = await new AxeBuilder({ page }).withRules(["heading-order", "page-has-heading-one"]).analyze();
  expect(order.violations.map((v) => v.id)).toEqual([]);
});

for (const path of ["/", "/projects", "/projects/task-board", "/projects/log-parser"]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on ${path} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      expect(await axe(page)).toEqual([]);
    });
  }
}

test("phone layout passes axe", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");
  expect(await axe(page)).toEqual([]);
});

// Local only: SAVE_SCREENSHOTS=1 writes them to docs/design/ (not committed).
for (const viewport of [PHONE, DESKTOP]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshot of home at ${viewport.width} px, ${scheme}`, async ({ page }) => {
      test.skip(!process.env.SAVE_SCREENSHOTS, "set SAVE_SCREENSHOTS=1 to save them");
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `../docs/design/home-${viewport.width}-${scheme}.png`,
        fullPage: true,
      });
    });
  }
}

test.describe("search engines", () => {
  const ORIGIN = "http://localhost:3100";

  test("the sitemap lists the pages open to search and nothing else", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    const locs = [...(await response.text()).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(
      expect.arrayContaining([`${ORIGIN}/`, `${ORIGIN}/projects`, `${ORIGIN}/projects/page/2`, `${ORIGIN}/projects/first-seeded-project`]),
    );
    expect(locs.every((loc) => loc.startsWith(`${ORIGIN}/`))).toBe(true);
    expect(locs.some((loc) => /\/desk|404|\/projects\/page\/3|seeded-project-3$/.test(loc))).toBe(false);
  });

  test("robots.txt names the sitemap and turns away AI crawlers only", async ({ request }) => {
    const text = await (await request.get("/robots.txt")).text();
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(text).toMatch(/User-Agent: GPTBot[\s\S]*Disallow: \//);
    expect(text).toMatch(/User-Agent: \*\nAllow: \//);
  });

  for (const path of ["/", "/projects", "/projects/page/2", "/projects/task-board"]) {
    test(`${path} has one absolute canonical on this site and preview tags`, async ({ page }) => {
      await page.goto(path);
      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      // Next writes the home address without its final slash; both name the same URL.
      const url = path === "/" ? new RegExp(`^${ORIGIN}/?$`) : `${ORIGIN}${path}`;
      await expect(canonical).toHaveAttribute("href", url);
      await expect(page.locator('meta[name="description"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", url);
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", `${ORIGIN}/og-default.png`);
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    });
  }

  test("the preview image is served", async ({ request }) => {
    const response = await request.get("/og-default.png");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });

  test("/desk stays out of search and is never stored", async ({ request }) => {
    const response = await request.get("/desk");
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.text()).not.toContain('rel="canonical"');
  });
});
