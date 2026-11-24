import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { frames, settled } from "./fixtures/settled";

// The section pager: a dot rail under 1000 px, a panel from 1000 px with every
// label from 1280 px, and the Next section button. The seed publishes six
// sections after the hero.

const SECTIONS = [
  ["about", "About me"],
  ["projects", "Selected work"],
  ["experience", "Work history"],
  ["education", "Study"],
  ["skills", "Toolkit"],
  ["contact", "Contact me"],
] as const;
const LABELS = ["About", "Projects", "Experience", "Education", "Skills", "Contact"];
const WIDTHS = [320, 390, 768, 1000, 1280, 1440, 1920];
const PRESETS = {
  A: "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4",
  B: "bf7b0ec6-833c-4f4c-be66-03ce086e298a",
  E: "b399fb8f-5de4-462d-98f5-a81bf8046a6f",
};

const pager = (page: Page) => page.getByRole("navigation", { name: "Sections" });
const nextButton = (page: Page) => pager(page).getByRole("button", { name: /Next section|Back to top/ });
const heightFor = (width: number) => (width < 760 ? 740 : 900);

async function home(page: Page, width: number) {
  await page.setViewportSize({ width, height: heightFor(width) });
  await page.goto("/");
  await expect(page.locator("[data-nav]")).toHaveAttribute("data-enhanced", "true");
  await expect(nextButton(page)).toBeVisible();
}

/** Boxes where the pager's plates and visible content (text, links,
    buttons, images, the clipped strip and carousel) overlap. */
function overlaps(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.visibility !== "hidden" && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
    };
    const plates = [...document.querySelectorAll(".pager ol, .pager__next")].filter(shown);
    const content = [
      ...document.querySelectorAll(
        "main :is(h1, h2, h3, h4, h5, p, li, a, button, img, input, label, dd, dt, .tile), .nav :is(a, button), .footer :is(p, a), .strip__view, [data-showcase-deck]",
      ),
    ].filter(
      (el) =>
        shown(el) &&
        !el.closest(".pager") &&
        !el.closest(".strip__view li") &&
        !(el.closest("[data-showcase-deck]") && !el.matches("[data-showcase-deck]")) &&
        !el.closest("[aria-hidden='true']"),
    );
    const found: string[] = [];
    for (const plate of plates) {
      const a = plate.getBoundingClientRect();
      for (const el of content) {
        const b = el.getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 1 && y > 1) found.push(`${el.tagName.toLowerCase()}.${el.className} "${el.textContent?.trim().slice(0, 20)}"`);
      }
    }
    return found;
  });
}

for (const width of WIDTHS) {
  test.describe(`${width} px`, () => {
    test("the pager is a rail below 1000 px and a panel above, with no sideways scroll", async ({ page }) => {
      await home(page, width);
      await expect(pager(page)).toBeVisible();
      await expect(pager(page)).toHaveCount(1);
      const links = pager(page).getByRole("link");
      await expect(links).toHaveCount(6);
      const first = (await links.first().boundingBox())!;
      if (width < 1000) {
        // Dots: each target is at least 44 by 44 px, the labels are for screen readers.
        for (const link of await links.all()) {
          const box = (await link.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await expect(pager(page).locator(".pager__label").first()).toHaveCSS("position", "absolute");
        expect(first.x + first.width).toBeGreaterThan(width - 50);
      } else if (width >= 1280) {
        for (const label of await pager(page).locator(".pager__label").all()) await expect(label).not.toHaveCSS("position", "absolute");
        await expect(pager(page).locator(".pager__next-label")).toBeVisible();
      } else {
        await expect(pager(page).locator(".pager__label").nth(2)).toHaveCSS("position", "absolute");
      }
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);
    });

    test("the pager covers no content at any section", async ({ page }) => {
      await home(page, width);
      expect(await overlaps(page), "top").toEqual([]);
      for (const [id] of SECTIONS) {
        await page.locator(`#${id}`).evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "start" }));
        await expect(page.locator(`#${id}`)).not.toHaveAttribute("data-reveal", "pending");
        await settled(page);
        expect(await overlaps(page), id).toEqual([]);
      }
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
      await settled(page);
      expect(await overlaps(page), "bottom").toEqual([]);
    });

    test("the pager steps aside for the menus and the project sheet", async ({ page }) => {
      await home(page, width);
      if (width < 760) {
        await page.getByRole("button", { name: "Menu" }).click();
        await expect(pager(page)).toBeHidden();
        await page.keyboard.press("Escape");
        await expect(pager(page)).toBeVisible();
      }
      await page.getByRole("button", { name: "Theme" }).click();
      await expect(pager(page)).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(pager(page)).toBeVisible();
      await page.locator("#projects").evaluate((el) => el.scrollIntoView({ behavior: "instant" }));
      await page.evaluate(() => (location.hash = "#project-task-board"));
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(pager(page)).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(pager(page)).toBeVisible();
    });

    test("aria-current follows scrolling", async ({ page }) => {
      await home(page, width);
      for (const [index, [id]] of SECTIONS.entries()) {
        await page.locator(`#${id}`).evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "start" }));
        await expect(pager(page).getByRole("link", { name: `Go to ${LABELS[index]}` })).toHaveAttribute(
          "aria-current",
          "location",
        );
        await expect(pager(page).locator("[aria-current]")).toHaveCount(1);
      }
    });

    test("Next section steps through every section, then back to the top", async ({ page }) => {
      await home(page, width);
      await expect(nextButton(page)).toHaveAccessibleName("Next section");
      for (const [id, heading] of SECTIONS) {
        await nextButton(page).click();
        await expect(page).toHaveURL(new RegExp(`#${id}$`));
        await expect(page.getByRole("heading", { level: 2, name: heading })).toBeFocused();
      }
      await expect(nextButton(page)).toHaveAccessibleName("Back to top");
      await nextButton(page).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(nextButton(page)).toHaveAccessibleName("Next section");
    });

    test("Next section works from the keyboard", async ({ page }) => {
      await home(page, width);
      await nextButton(page).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 2, name: "About me" })).toBeFocused();
      await nextButton(page).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("heading", { level: 2, name: "Selected work" })).toBeFocused();
    });

    for (const scheme of ["light", "dark"] as const) {
      test(`axe finds nothing with the pager (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await home(page, width);
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(result.violations.map((v) => v.id)).toEqual([]);
      });
    }
  });
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  for (const width of [390, 1280]) {
    test(`at ${width} px Next section jumps without a smooth scroll`, async ({ page }) => {
      await home(page, width);
      await nextButton(page).click();
      const first = await page.evaluate(() => Math.round(window.scrollY));
      // A smooth scroll would have moved within these frames.
      await frames(page);
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(first);
      expect(first).toBeGreaterThan(0);
      await expect(page.getByRole("heading", { level: 2, name: "About me" })).toBeFocused();
    });
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const width of [390, 1280]) {
    test(`at ${width} px the links work and the button is not shown`, async ({ page }) => {
      await page.setViewportSize({ width, height: heightFor(width) });
      await page.goto("/");
      await expect(pager(page).getByRole("button")).toBeHidden();
      await pager(page).getByRole("link", { name: "Go to Projects" }).click();
      await expect(page).toHaveURL(/#projects$/);
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "Back to top" })).toHaveAttribute("href", "#top");
    });
  }
});

// Every colour the rail, panel and button use against the page background,
// in each palette visitors can pick, light and dark. (Every preset, enabled or
// not, is checked for the same pair in api/tests/test_palettes.py.)
for (const [name, id] of Object.entries(PRESETS)) {
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [390, 1280]) {
      test(`palette ${name} ${scheme} at ${width} px: pager colours meet 3:1`, async ({ page }) => {
        await page.addInitScript((palette) => localStorage.setItem("palette", palette), id);
        await page.emulateMedia({ colorScheme: scheme });
        await home(page, width);
        await expect(page.locator("html")).toHaveAttribute("data-palette", id);
        await page.locator("#projects").evaluate((el) => el.scrollIntoView({ behavior: "instant" }));
        await expect(pager(page).locator("[aria-current]")).toHaveCount(1);
        const ratios = await page.evaluate(() => {
          const rgb = (value: string) => (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
          const lum = ([r, g, b]: number[]) => {
            const c = [r, g, b].map((v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          };
          const ratio = (a: string, b: string) => {
            const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m);
            return (x + 0.05) / (y + 0.05);
          };
          const probe = document.createElement("div");
          probe.className = "pager-probe";
          document.querySelector(".site")!.append(probe);
          probe.style.backgroundColor = "var(--c-bg)";
          const bg = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const found: Record<string, number> = {};
          const take = (label: string, el: Element | null, pseudo?: string) => {
            if (!el) return;
            const style = getComputedStyle(el, pseudo);
            for (const prop of ["color", "borderTopColor", "backgroundColor"] as const) {
              const value = style[prop];
              if (!value || value === "rgba(0, 0, 0, 0)" || value === bg) continue;
              found[`${label} ${prop}`] = Math.round(ratio(value, bg) * 100) / 100;
            }
          };
          take("link", document.querySelector(".pager a:not([aria-current])"));
          take("current", document.querySelector(".pager a[aria-current]"));
          take("dot", document.querySelector(".pager a:not([aria-current])"), "::before");
          take("current dot", document.querySelector(".pager a[aria-current]"), "::before");
          take("plate", document.querySelector(".pager ol"));
          take("button", document.querySelector(".pager__next"));
          take("arrow", document.querySelector(".pager__arrow"));
          return found;
        });
        expect(Object.keys(ratios).length).toBeGreaterThan(2);
        for (const [what, value] of Object.entries(ratios)) expect(value, what).toBeGreaterThanOrEqual(3);
      });
    }
  }
}
