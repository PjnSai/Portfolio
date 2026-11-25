import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The footer pages, the 404 page and the footer itself (SPEC 3.10, 8.3).

const FOOTER_PAGES = [
  ["/privacy", "Privacy"],
  ["/accessibility", "Accessibility"],
  ["/security", "Security"],
  ["/how-this-site-is-built", "How this site is built"],
] as const;

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const footerNav = (page: Page) => page.getByRole("contentinfo").getByRole("navigation", { name: "Footer" });

for (const [path, title] of FOOTER_PAGES) {
  test(`${path} is a real page with one h1, the site nav and the footer`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `http://localhost:3100${path}`);
    await expect(page).toHaveTitle(new RegExp(`^${title}`));
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on ${path} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      expect(await axe(page)).toEqual([]);
    });
  }
}

test("the privacy notice names exactly what is kept in the browser", async ({ page }) => {
  await page.goto("/privacy");
  const main = page.getByRole("main");
  for (const key of ["palette", "theme", "palette-last", "palette-visit"]) {
    await expect(main.locator("code", { hasText: new RegExp(`^${key}$`) })).toHaveCount(1);
  }
  await expect(main).toContainText("sets no cookies");
  // The CV: the viewer, the request, the link that lasts a minute and the log.
  for (const words of ["The CV", "one minute", "casual saving", "marked as a CV request", "No IP address"]) {
    await expect(main).toContainText(words);
  }
  await expect(main).not.toContainText("not available yet");
  // The contact form is described: what it keeps, for how long, and Turnstile.
  for (const words of ["Contact form", "12 months", "30 days", "Cloudflare Turnstile", "challenges.cloudflare.com", "keyed hash", "needs JavaScript"]) {
    await expect(main).toContainText(words);
  }
});

test("every page has the footer links, and they work by keyboard", async ({ page }) => {
  for (const path of ["/", "/projects", "/projects/task-board", "/privacy", "/no-such-page"]) {
    await page.goto(path);
    const nav = footerNav(page);
    await expect(nav.getByRole("link")).toHaveText([
      "All projects",
      "Privacy",
      "Accessibility",
      "Security",
      "How this site is built",
      "Back to top",
    ]);
  }
  await page.goto("/projects");
  const privacy = footerNav(page).getByRole("link", { name: "Privacy" });
  await privacy.focus();
  await expect(privacy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy");
});

test("security.txt is served with a contact and the policy page", async ({ request }) => {
  const response = await request.get("/.well-known/security.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  const text = await response.text();
  expect(text).toMatch(/^Contact: https:\/\/github\.com\/PjnSai\/Portfolio\/security\/advisories\/new$/m);
  expect(text).toContain("Policy: http://localhost:3100/security");
  const expires = Date.parse(/^Expires: (.+)$/m.exec(text)?.[1] ?? "");
  expect(expires).toBeGreaterThan(Date.now());
});

test("an unknown address gets the branded 404 page with status 404", async ({ page, request }) => {
  const missing = await request.get("/no-such-page");
  expect(missing.status()).toBe(404);
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
  await expect(main.getByRole("link", { name: "See all projects" })).toHaveAttribute("href", "/projects");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing on the 404 page (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/no-such-page");
    expect(await axe(page)).toEqual([]);
  });
}
