import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The seed (api/tests/e2e_server.py) publishes eight projects, the Ring layout
// and the visitor layout switcher, so every layout can be tried here.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const LAYOUTS = ["Ring", "Vertical", "Stack", "Train"] as const;

const showcase = (page: Page) => page.locator("[data-showcase]");
const slots = (page: Page) => page.locator("[data-slot]");
const front = (page: Page) => page.locator('[data-slot][data-offset="0"]');
const counter = (page: Page) => page.locator("[data-showcase-count]");
const status = (page: Page) => page.locator("[data-showcase-status]");
const sheet = (page: Page) => page.getByRole("dialog");
const strip = (page: Page) => page.locator("[data-marquee]");
const stripButton = (page: Page) => strip(page).getByRole("button");
const playState = (page: Page) =>
  page.locator(".strip__track").evaluate((el) => getComputedStyle(el).animationPlayState);

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

// The page is usable before the script runs; wait for it where a test needs it.
async function home(page: Page, path = "/") {
  await page.goto(path);
  await expect(showcase(page)).toHaveAttribute("data-enhanced", "true");
  await expect(strip(page)).toHaveAttribute("data-state", /playing|paused/);
  await settle(page);
}

// Brings the projects section into view and waits until its enter transition
// and any card movement have finished, so clicks land where they aim.
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

async function useLayout(page: Page, name: (typeof LAYOUTS)[number]) {
  await home(page);
  await page.getByRole("radio", { name }).check();
  await expect(showcase(page)).toHaveAttribute("data-layout", name.toLowerCase());
  await expect(showcase(page)).toHaveAttribute("data-mode", "3d");
  await settle(page);
}

const focusRing = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
  });

test("the owner's layout is in the prerendered page", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain('data-layout="ring"');
  expect(html).not.toMatch(/data-offset=/);
});

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  for (const name of LAYOUTS) {
    test(`${name}: renders, and keyboard order follows reading order`, async ({ page }) => {
      await useLayout(page, name);
      await expect(slots(page)).toHaveCount(8);
      await expect(front(page)).toHaveCount(1);
      await expect(front(page).getByRole("link", { name: "Task board" })).toBeVisible();
      // Side cards are decorative to screen readers and out of the Tab order.
      await expect(page.locator('[data-slot][aria-hidden="true"]')).toHaveCount(7);
      await expect(counter(page)).toHaveText("01 / 08");

      await page.getByRole("radio", { name }).focus();
      await page.keyboard.press("Tab");
      await expect(front(page).getByRole("link", { name: "Task board" })).toBeFocused();
      expect(await focusRing(page)).toBe(true);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Previous project" })).toBeFocused();
      expect(await focusRing(page)).toBe(true);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Next project" })).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(counter(page)).toHaveText("02 / 08");
      await expect(status(page)).toHaveText("Project 2 of 8: Log parser");
      await expect(front(page).getByRole("link", { name: "Log parser" })).toBeVisible();

      // Arrow keys move too; from the front card, focus follows the new front card.
      await front(page).getByRole("link").focus();
      await page.keyboard.press(name === "Vertical" ? "ArrowDown" : "ArrowRight");
      await expect(counter(page)).toHaveText("03 / 08");
      await expect(front(page).getByRole("link", { name: "Seeded project 3" })).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(counter(page)).toHaveText("02 / 08");

      await page.getByRole("button", { name: "Project 8 of 8: Seeded project 8" }).click();
      await expect(counter(page)).toHaveText("08 / 08");
      await page.getByRole("button", { name: "Next project" }).click();
      await expect(counter(page)).toHaveText("01 / 08");
    });

    for (const scheme of ["light", "dark"] as const) {
      test(`${name}: axe finds nothing (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await useLayout(page, name);
        expect(await axe(page)).toEqual([]);
      });
    }
  }

  test("every palette paints the cards and the controls in light and dark", async ({ page }) => {
    await home(page);
    const ids = await page.locator('input[name="palette"]').evaluateAll((all) =>
      all.map((input) => (input as HTMLInputElement).value),
    );
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          ([p, t]) => {
            document.documentElement.dataset.palette = p;
            document.documentElement.dataset.theme = t;
          },
          [id, theme],
        );
        await settle(page);
        const result = await new AxeBuilder({ page }).include("#projects").withRules(["color-contrast"]).analyze();
        expect(result.violations.map((v) => v.id), `${id} ${theme}`).toEqual([]);
      }
    }
  });

  test("clicking a side card brings it to the front; clicking the front card opens its sheet", async ({
    page,
  }) => {
    await useLayout(page, "Train");
    await page.locator('[data-slot][data-offset="1"]').click();
    await expect(counter(page)).toHaveText("02 / 08");
    await settle(page);
    await front(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole("heading", { name: "Log parser" })).toBeVisible();
  });

  test("the detail sheet opens, links and closes by button, Escape and a click outside", async ({ page }) => {
    await home(page);
    const link = front(page).getByRole("link", { name: "Task board" });
    await link.click();
    await expect(sheet(page)).toBeVisible();
    await expect(page).toHaveURL(/#project-task-board$/);
    await expect(sheet(page).getByRole("heading", { name: "Task board" })).toBeVisible();
    await expect(sheet(page).getByText("What I built")).toBeVisible();
    await expect(sheet(page).getByRole("link", { name: "Full case study" })).toHaveAttribute(
      "href",
      /\/projects\/task-board$/,
    );
    await expect(sheet(page).getByRole("button", { name: "Close project details" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect(link).toBeFocused();
    await expect(page).not.toHaveURL(/#project-/);

    await page.keyboard.press("Enter");
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole("button", { name: "Close project details" }).click();
    await expect(sheet(page)).toBeHidden();

    await link.click();
    await page.mouse.click(5, 5);
    await expect(sheet(page)).toBeHidden();
  });

  test("a project can be linked to", async ({ page }) => {
    await home(page, "/#project-log-parser");
    await expect(sheet(page).getByRole("heading", { name: "Log parser" })).toBeVisible();
    await expect(counter(page)).toHaveText("02 / 08");
  });

  test("a swipe on the deck moves between projects", async ({ page }) => {
    await home(page);
    const box = (await front(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 20, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, y, { steps: 5 });
    await page.mouse.up();
    await expect(counter(page)).toHaveText("02 / 08");
    await expect(sheet(page)).toBeHidden();
  });
});

test("760 to 1000 px: 3D with one side card each way", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await home(page);
  await expect(showcase(page)).toHaveAttribute("data-mode", "3d");
  await expect(page.locator('[data-slot][data-offset="2"]')).toBeHidden();
  await expect(page.locator('[data-slot][data-offset="1"]')).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("the showcase is a swipe carousel with the same controls", async ({ page }) => {
    await home(page);
    await expect(showcase(page)).toHaveAttribute("data-mode", "flat");
    await expect(page.locator("[data-slot][aria-hidden]")).toHaveCount(0);
    await page.getByRole("button", { name: "Next project" }).tap();
    await expect(counter(page)).toHaveText("02 / 08");
    const deck = page.locator("[data-showcase-deck]");
    await expect.poll(() => deck.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  });

  test("a second press during the smooth scroll counts from the target card", async ({ page }) => {
    await home(page);
    await expect(showcase(page)).toHaveAttribute("data-mode", "flat");
    await settle(page);
    await page.getByRole("button", { name: "Next project" }).tap();
    await page.getByRole("button", { name: "Previous project" }).tap();
    await expect(counter(page)).toHaveText("01 / 08");
    await page.waitForTimeout(1200);
    await expect(counter(page)).toHaveText("01 / 08");
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: DESKTOP, reducedMotion: "reduce" });

  test("the 3D layouts become the static carousel and no section is held back", async ({ page }) => {
    await home(page);
    await expect(showcase(page)).toHaveAttribute("data-mode", "flat");
    await expect(page.locator("[data-reveal]")).toHaveCount(0);
    const transition = await page
      .locator("[data-slot]")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
  });

  test("the skills strip starts paused and the visitor can start it", async ({ page }) => {
    await home(page);
    await page.mouse.move(0, 0);
    await expect(strip(page)).toHaveAttribute("data-state", "paused");
    await expect(stripButton(page)).toHaveAccessibleName("Play the skills strip");
    expect(await playState(page)).toBe("paused");
    await stripButton(page).click();
    await page.mouse.move(0, 0);
    await page.locator("body").focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(strip(page)).toHaveAttribute("data-state", "playing");
    await expect.poll(() => playState(page)).toBe("running");
  });
});

test.describe("section transitions", () => {
  test.use({ viewport: DESKTOP });

  test("sections below the fold enter as they scroll into view", async ({ page }) => {
    await home(page);
    const contact = page.locator("#contact");
    await expect(contact).toHaveAttribute("data-reveal", "pending");
    await contact.scrollIntoViewIfNeeded();
    await expect(contact).toHaveAttribute("data-reveal", "in");
    await expect.poll(() => contact.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });

  test("a jump link lands focus on a section that is fully shown", async ({ page }) => {
    await home(page);
    await page.locator(".nav").getByRole("link", { name: "Get in touch" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Contact me" })).toBeFocused();
    const contact = page.locator("#contact");
    await expect(contact).toHaveAttribute("data-reveal", "now");
    expect(await contact.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    expect(await contact.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  });

  test("tabbing into a section shows it at once", async ({ page }) => {
    await home(page);
    await page.locator("#contact a").first().focus();
    const contact = page.locator("#contact");
    await expect(contact).toHaveAttribute("data-reveal", "now");
    expect(await contact.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });

  test("a page opened at a section shows it without a transition", async ({ page }) => {
    await home(page, "/#contact");
    await expect(page.locator("#contact")).not.toHaveAttribute("data-reveal", "pending");
  });
});

test.describe("skills strip", () => {
  test.use({ viewport: DESKTOP });

  test("is named, has one readable copy, and pauses by mouse, keyboard, hover and focus", async ({ page }) => {
    await home(page);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("region", { name: "Skills strip" })).toBeVisible();
    await expect(strip(page).locator("ul")).toHaveCount(2);
    const copy = strip(page).locator("ul").nth(1);
    await expect(copy).toHaveAttribute("aria-hidden", "true");
    expect(await copy.evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    await expect(strip(page)).toHaveAttribute("data-state", "playing");
    expect(await playState(page)).toBe("running");

    await page.locator(".strip__view").hover();
    expect(await playState(page)).toBe("paused");
    await page.mouse.move(0, 0);
    expect(await playState(page)).toBe("running");

    await stripButton(page).focus();
    expect(await playState(page)).toBe("paused");
    await expect(strip(page)).toHaveAttribute("data-state", "playing");

    await page.keyboard.press("Enter");
    await expect(strip(page)).toHaveAttribute("data-state", "paused");
    await expect(strip(page).locator("[data-marquee-status]")).toHaveText("Skills strip paused.");
    await expect(stripButton(page)).toHaveAccessibleName("Play the skills strip");
    await page.keyboard.press("Space");
    await expect(strip(page)).toHaveAttribute("data-state", "playing");
    await expect(strip(page).locator("[data-marquee-status]")).toHaveText("Skills strip playing.");

    await stripButton(page).click();
    await expect(strip(page)).toHaveAttribute("data-state", "paused");
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await playState(page)).toBe("paused");
  });
});

test.describe("skills strip on touch", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("a tap pauses and plays it", async ({ page }) => {
    await home(page);
    await stripButton(page).tap();
    await expect(strip(page)).toHaveAttribute("data-state", "paused");
    await stripButton(page).tap();
    await expect(strip(page)).toHaveAttribute("data-state", "playing");
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false, viewport: DESKTOP });

  test("every section is shown and every project is a plain card", async ({ page }) => {
    await page.goto("/");
    const sections = page.locator("[data-section]");
    const count = await sections.count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i += 1) {
      const section = sections.nth(i);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      expect(await section.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect(await section.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    }
    await expect(page.locator("[data-showcase-controls]")).toBeHidden();
    await expect(page.locator("[data-showcase-switch]")).toBeHidden();
    await expect(page.locator("[data-slot] article")).toHaveCount(8);
    for (const title of ["Task board", "Seeded project 8"]) {
      await expect(page.locator("[data-slot]").getByRole("link", { name: title })).toBeVisible();
    }
    await expect(stripButton(page)).toBeHidden();
    await expect(strip(page).locator("ul")).toHaveCount(1);
    await expect(strip(page).getByText("OWASP ASVS")).toBeVisible();
  });

  test("every pagination link works", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.locator("article")).toHaveCount(6);
    const pages = page.getByRole("navigation", { name: "Project pages" });
    await expect(pages.getByRole("link", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    await pages.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/\/projects\/page\/2$/);
    await expect(page.locator("article")).toHaveCount(2);
    await expect(pages.getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    await expect(pages.getByRole("link", { name: "Next page" })).toHaveCount(0);
    await pages.getByRole("link", { name: "Previous page" }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await pages.getByRole("link", { name: "Page 2" }).click();
    await expect(page).toHaveURL(/\/projects\/page\/2$/);
    await pages.getByRole("link", { name: "Page 1" }).click();
    await expect(page).toHaveURL(/\/projects$/);
  });
});

test("pagination: canonical links, keyboard use and pages past the end", async ({ page, request }) => {
  await page.goto("/projects");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/projects$/);
  await expect(page.locator('link[rel="next"]')).toHaveAttribute("href", /\/projects\/page\/2$/);
  await page.getByRole("link", { name: "Next page" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects\/page\/2$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Projects, page 2");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/projects\/page\/2$/);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Seeded project 7", "Seeded project 8"]);

  const missing = await request.get("/projects/page/3");
  expect(missing.status()).toBe(404);
  await page.goto("/projects/page/3");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page.getByRole("main").getByRole("link", { name: "See all projects" })).toHaveAttribute("href", "/projects");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing on /projects/page/2 (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/projects/page/2");
    expect(await axe(page)).toEqual([]);
  });
}
