import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Combo } from "../playwright.matrix.config";

// Each project in playwright.matrix.config.ts is one browser, width, colour
// scheme and motion setting, or a run with JavaScript off. The site is the
// one the e2e run builds from api/tests/e2e_server.py (eight projects).

const combo = () => test.info().project.metadata as Combo;
const PHONE = 760;
const PAGES = [
  "/",
  "/projects",
  "/projects/task-board",
  "/privacy",
  "/accessibility",
  "/security",
  "/how-this-site-is-built",
  "/no-such-page",
];

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Waits for the scripts that enhance the page, when they can run. */
async function open(page: Page, path: string) {
  const response = await page.goto(path);
  if (combo().js) await expect(page.locator("[data-nav]")).toHaveAttribute("data-enhanced", "true");
  return response;
}

/** Brings the projects into view and waits for their enter transition and any
    card movement to finish, so clicks land where they aim. */
async function settle(page: Page) {
  const section = page.locator("#projects");
  await section.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      section.evaluate(
        (el) =>
          getComputedStyle(el).opacity === "1" &&
          el.getAnimations({ subtree: true }).every((a) => a.playState !== "running"),
      ),
    )
    .toBe(true);
}

test("no page scrolls sideways", async ({ page }) => {
  for (const path of PAGES) {
    await open(page, path);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
});

/** The heading a jump landed on is in view and not under the sticky nav. */
async function expectClearOfNav(page: Page, heading: string) {
  await expect
    .poll(async () => {
      const nav = await page.locator("[data-nav]").boundingBox();
      const target = await page.getByRole("heading", { level: 2, name: heading }).boundingBox();
      return nav && target ? Math.round(target.y - (nav.y + nav.height)) : -1;
    })
    .toBeGreaterThanOrEqual(0);
}

test("the page stays where it loads", async ({ page }) => {
  await open(page, "/");
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
});

test("the nav and the burger menu work", async ({ page }) => {
  const { js, width } = combo();
  await open(page, "/projects");
  const burger = mainNav(page).getByRole("button", { name: "Menu" });
  const projectsLink = mainNav(page).getByRole("link", { name: /Projects/ });
  if (!js || width >= PHONE) {
    await expect(burger).toBeHidden();
    await expect(projectsLink).toBeVisible();
    await projectsLink.click();
    await expect(page).toHaveURL(/\/#projects$/);
    await expectClearOfNav(page, "Selected work");
    return;
  }
  await expect(burger).toBeVisible();
  await expect(projectsLink).toBeHidden();
  await burger.focus();
  await page.keyboard.press("Enter");
  await expect(burger).toHaveAttribute("aria-expanded", "true");
  await expect(projectsLink).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(burger).toHaveAttribute("aria-expanded", "false");
  await expect(burger).toBeFocused();
  await burger.click();
  await projectsLink.click();
  await expect(page).toHaveURL(/\/#projects$/);
  await expectClearOfNav(page, "Selected work");
});

test("the showcase works in the mode for this width", async ({ page }) => {
  const { js, width, motion } = combo();
  await open(page, "/");
  const showcase = page.locator("[data-showcase]");
  const slots = page.locator("[data-slot]");
  await expect(slots).toHaveCount(8);
  if (!js) {
    await expect(showcase).not.toHaveAttribute("data-mode", /./);
    await expect(page.getByRole("button", { name: "Next project" })).toBeHidden();
    for (const title of ["Task board", "Seeded project 8"]) {
      await expect(showcase.getByRole("link", { name: title })).toBeVisible();
    }
    return;
  }
  const mode = width >= PHONE && motion === "no-preference" ? "3d" : "flat";
  await expect(showcase).toHaveAttribute("data-mode", mode);
  await settle(page);
  const counter = page.locator("[data-showcase-count]");
  await expect(counter).toHaveText("01 / 08");
  await page.getByRole("button", { name: "Next project" }).click();
  await expect(counter).toHaveText("02 / 08");
  await page.getByRole("button", { name: "Previous project" }).click();
  await expect(counter).toHaveText("01 / 08");
});

test("project pagination works", async ({ page }) => {
  await open(page, "/projects");
  await page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/\/projects\/page\/2$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Projects, page 2");
  const current = page.getByRole("navigation", { name: "Project pages" }).locator('[aria-current="page"]');
  await expect(current).toHaveText(/2/);
});

test("the theme menu works, or stays hidden without JavaScript", async ({ page }) => {
  await open(page, "/");
  const toggle = page.getByRole("button", { name: "Theme" });
  if (!combo().js) {
    await expect(toggle).toBeHidden();
    return;
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const choice = combo().scheme === "dark" ? "Light" : "Dark";
  await page.getByRole("radio", { name: choice, exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", choice.toLowerCase());
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the skills strip can be paused, and starts paused under reduced motion", async ({ page }) => {
  await open(page, "/");
  const strip = page.locator("[data-marquee]");
  const button = strip.getByRole("button");
  if (!combo().js) {
    await expect(button).toHaveCount(0);
    return;
  }
  if (combo().motion === "reduce") {
    await expect(strip).toHaveAttribute("data-state", "paused");
    await expect(button).toHaveText(/Play/);
    return;
  }
  await expect(strip).toHaveAttribute("data-state", "playing");
  await button.click();
  await expect(strip).toHaveAttribute("data-state", "paused");
  await expect(button).toHaveText(/Play/);
  await button.press("Enter");
  await expect(strip).toHaveAttribute("data-state", "playing");
});

test("a case study, the footer pages and the 404 page read in full", async ({ page }) => {
  await open(page, "/projects/task-board");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Task board");
  await expect(page.getByRole("heading", { level: 2, name: "Case study" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Project facts" })).toBeVisible();
  for (const [path, title] of [
    ["/privacy", "Privacy"],
    ["/accessibility", "Accessibility"],
    ["/security", "Security"],
    ["/how-this-site-is-built", "How this site is built"],
  ]) {
    await open(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toBeVisible();
  }
  const response = await open(page, "/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
});

test("axe finds nothing on the public pages", async ({ page: own, browser }) => {
  const { width, js } = combo();
  test.skip(width !== 390 && width !== 1280, "axe runs at 390 and 1280 px");
  // axe needs JavaScript, so the no-JavaScript run checks the same static
  // pages with the site's script files blocked instead.
  let page = own;
  if (!js) {
    const context = await browser.newContext({ ...test.info().project.use, javaScriptEnabled: true });
    await context.route("**/_next/static/**/*.js", (route) => route.abort());
    page = await context.newPage();
  }
  for (const path of PAGES) {
    await open(page, path);
    if (js && path === "/") await expect(page.locator("[data-showcase]")).toHaveAttribute("data-mode", /./);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const found = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(found, path).toEqual([]);
  }
});
