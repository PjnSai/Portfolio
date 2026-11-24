import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import { API } from "./fixtures/contact";
import { stubTurnstile, withAddress } from "./fixtures/form";

// The public contact form. The Turnstile script is replaced by a stand-in with
// Cloudflare's dummy behaviour, so these tests need no network; the one test
// with the real script runs only with TURNSTILE_LIVE=1 (see the end).

const FORM = "[data-contact-form]";
// Each test gets its own email and message: the API allows three a day from
// one email address and refuses to take the same text twice in a day.
let counter = 0;
const run = Date.now().toString(36);
const fresh = () => {
  counter += 1;
  return {
    name: "Taylor Tester",
    email: `taylor.${run}.${counter}@example.com`,
    body: `Hello, this is test message ${counter} (${run}) sent by the browser suite.`,
  };
};
let GOOD = fresh();
test.beforeEach(() => {
  GOOD = fresh();
});

async function open(page: Page, route = true) {
  if (route) {
    await stubTurnstile(page);
    await withAddress(page);
  }
  await page.goto("/");
}

async function reach(page: Page) {
  await page.locator(FORM).scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
}

async function fill(page: Page, values = GOOD, reason = "") {
  await page.getByLabel(/^Name/).fill(values.name);
  await page.getByLabel(/^Email/).fill(values.email);
  if (reason) await page.getByLabel(/^Reason/).selectOption(reason);
  await page.getByLabel(/^Message/).fill(values.body);
}

const contactPosts = (page: Page) => {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url() === `${API}/api/v1/contact`
    )
      seen.push(request);
  });
  return seen;
};

/** The height of the section that holds the form, in whole pixels. */
const sectionHeight = async (page: Page) =>
  Math.round(
    (await page
      .locator(".section--contact")
      .evaluate((el) => (el as HTMLElement).offsetHeight)) as number,
  );

test("without JavaScript the form is hidden and the page says why, with no email address", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");

  // Playwright's text search skips <noscript>, so read it as a person would.
  const note = page.locator(`${FORM} noscript p.contact-note`);
  await expect(note).toBeVisible();
  await expect(note).toContainText("The contact form needs JavaScript");
  await expect(note).toContainText("professional links below");
  await expect(page.getByRole("button", { name: "Send message" })).toBeHidden();
  await expect(page.getByLabel(/^Name/)).toBeHidden();
  const section = page.locator(".section--contact");
  await expect(section.getByRole("link").first()).toBeVisible();
  expect(await section.innerText()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  expect(await page.content()).not.toContain("mailto:");
  await context.close();
});

test("the form code and Turnstile load only when the form is near the page or takes focus", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await open(page);
  await page.waitForLoadState("networkidle");

  expect(
    requests.some((url) => url.includes("challenges.cloudflare.com")),
  ).toBe(false);
  const chunksBefore = requests.filter((url) =>
    url.includes("/_next/static/chunks/"),
  ).length;
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();

  await page.locator(FORM).scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
  const cloudflare = requests.filter((url) =>
    url.includes("challenges.cloudflare.com"),
  );
  expect(cloudflare).toEqual([
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  ]);
  expect(
    requests.filter((url) => url.includes("/_next/static/chunks/")).length,
  ).toBeGreaterThan(chunksBefore);
});

test("focus alone brings the form to life, however far away it is", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await open(page);
  await page.waitForLoadState("networkidle");
  expect(
    requests.some((url) => url.includes("challenges.cloudflare.com")),
  ).toBe(false);

  await page.evaluate(() =>
    document.getElementById("contact-name")?.focus({ preventScroll: true }),
  );

  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
  expect(
    requests.some((url) => url.includes("challenges.cloudflare.com")),
  ).toBe(true);
});

test("a message is sent with no cookie, no referrer and no credentials, and a clear confirmation follows", async ({
  page,
}) => {
  const posts = contactPosts(page);
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      consoleProblems.push(message.text());
  });
  await open(page);
  await reach(page);
  const before = await sectionHeight(page);

  await fill(page, GOOD, "hiring");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
  const sent = page.locator("#contact-sent");
  await expect(sent).toBeVisible();
  await expect(sent).toBeFocused();
  await expect(sent).toContainText("Message sent");
  await expect(sent).toContainText(
    "Thank you. Your message has been received.",
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Thank you. Your message has been received." }),
  ).toHaveCount(1);

  expect(posts).toHaveLength(1);
  const headers = await posts[0].allHeaders();
  expect(headers.origin).toBe("http://localhost:3100");
  expect(headers.cookie).toBeUndefined();
  expect(headers.referer).toBeUndefined();
  expect(headers["content-type"]).toBe("application/json");
  const body = posts[0].postDataJSON();
  expect(body).toMatchObject({ ...GOOD, reason: "hiring", website: "" });
  expect(body.turnstile).toMatch(/^XXXX\.DUMMY\.TOKEN\.XXXX/);
  expect(Number.isInteger(body.elapsed)).toBe(true);
  expect(Object.keys(body).sort()).toEqual([
    "body",
    "elapsed",
    "email",
    "name",
    "reason",
    "turnstile",
    "website",
  ]);
  expect(await sectionHeight(page)).toBe(before);
  expect(consoleProblems).toEqual([]);

  await page.getByRole("button", { name: "Send another message" }).click();
  await expect(page.getByLabel(/^Name/)).toHaveValue("");
  expect(await sectionHeight(page)).toBe(before);
});

test("problems are found before anything is sent, said in words, and focus goes to the first", async ({
  page,
}) => {
  const posts = contactPosts(page);
  await open(page);
  await reach(page);
  const before = await sectionHeight(page);

  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await expect(page.getByLabel(/^Name/)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#contact-name-error")).toHaveText(
    "Error: Enter your name.",
  );
  await expect(page.locator("#contact-email-error")).toHaveText(
    "Error: Enter a valid email address.",
  );
  await expect(page.locator("#contact-body-error")).toHaveText(
    "Error: Write a little more.",
  );
  await expect(page.locator("#contact-reason-error")).toHaveText("");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "There are 3 problems: Name, Email and Message." }),
  ).toBeVisible();
  expect(posts).toHaveLength(0);
  expect(await sectionHeight(page)).toBe(before);

  await page.getByLabel(/^Name/).fill("Taylor");
  await page.getByLabel(/^Email/).fill("taylor@example.com");
  await page
    .getByLabel(/^Message/)
    .fill("A message that is long enough to send.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#contact-sent")).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("what the server says about a field is shown beside that field", async ({
  page,
}) => {
  await open(page);
  await page.route(`${API}/api/v1/contact`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "http://localhost:3100" },
      body: JSON.stringify({
        detail: "Some fields need changing.",
        errors: { email: ["Enter a valid email address."] },
      }),
    });
  });
  await reach(page);
  await fill(page);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.locator("#contact-email-error")).toHaveText(
    "Error: Enter a valid email address.",
  );
  await expect(page.getByLabel(/^Email/)).toBeFocused();
  await expect(page.getByLabel(/^Name/)).toHaveValue(GOOD.name);
});

test("a rate limit says how long to wait and keeps what was typed", async ({
  page,
}) => {
  await open(page);
  let limited = true;
  await page.route(`${API}/api/v1/contact`, async (route) => {
    if (route.request().method() !== "POST" || !limited)
      return route.fallback();
    return route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:3100",
        "Retry-After": "1800",
        "Access-Control-Expose-Headers": "Retry-After",
      },
      body: JSON.stringify({
        detail: "Too many messages. Please try again later.",
        code: "rate_limited",
      }),
    });
  });
  await reach(page);
  const before = await sectionHeight(page);
  await fill(page);
  await page.getByRole("button", { name: "Send message" }).click();

  const status = page
    .getByRole("status")
    .filter({ hasText: "Too many messages" });
  await expect(status).toContainText("try again in about 30 minutes");
  await expect(page.getByLabel(/^Message/)).toHaveValue(GOOD.body);
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeEnabled();
  expect(await sectionHeight(page)).toBe(before);

  limited = false;
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#contact-sent")).toBeVisible();
});

test("a failed anti-spam check says so without saying why, and can be tried again", async ({
  page,
}) => {
  await open(page);
  let refuse = true;
  await page.route(`${API}/api/v1/contact`, async (route) => {
    if (route.request().method() !== "POST" || !refuse) return route.fallback();
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "http://localhost:3100" },
      body: JSON.stringify({
        detail: "The anti-spam check did not pass. Please try again.",
        code: "challenge",
      }),
    });
  });
  await reach(page);
  await fill(page);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(
    page.getByRole("status").filter({
      hasText: "The anti-spam check did not pass. Please try again.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue(GOOD.name);

  refuse = false;
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#contact-sent")).toBeVisible();
});

test("if Turnstile cannot run, nothing is sent and the visitor is told", async ({
  page,
}) => {
  const posts = contactPosts(page);
  await stubTurnstile(page, { fail: true });
  await withAddress(page);
  await page.goto("/");
  await reach(page);
  await fill(page);

  await page.getByRole("button", { name: "Send message" }).click();

  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The anti-spam check could not run." }),
  ).toBeVisible();
  expect(posts).toHaveLength(0);
  await expect(page.getByLabel(/^Message/)).toHaveValue(GOOD.body);
});

test("a message can be written and sent with the keyboard alone, and the trap field is skipped", async ({
  page,
}) => {
  await open(page);
  await reach(page);
  await page.getByLabel(/^Name/).focus();

  await page.keyboard.type(GOOD.name);
  await page.keyboard.press("Tab");
  await page.keyboard.type(GOOD.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/^Reason/)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await page.keyboard.type(GOOD.body);
  await page.keyboard.press("Tab");

  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.id,
    ),
  ).not.toBe("contact-website");
  await page.keyboard.press("Enter");

  await expect(page.locator("#contact-sent")).toBeFocused();
});

/** Hold every script of the site back, as a slow connection would, so nothing
 * on the page (the form's loader included) has run yet. */
async function slowCode(page: Page) {
  await page.route("**/_next/static/**/*.js", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
}

/** Every request the page makes after this call that could carry what was
 * typed: a navigation of the page (a native submit) or anything whose address
 * or body holds the text. */
function carriers(page: Page, text: string) {
  const seen: string[] = [];
  page.on("request", (request) => {
    const navigation =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const holds = `${request.url()} ${request.postData() ?? ""}`.includes(text);
    if (navigation || holds) seen.push(`${request.method()} ${request.url()}`);
  });
  return seen;
}

/** The defined signal that the form's code has taken over the markup. */
const codeArrived = (page: Page) =>
  expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({
    timeout: 15_000,
  });

test("a script's requestSubmit() before the form's code has arrived sends no values and puts nothing in the address", async ({
  page,
}) => {
  const posts = contactPosts(page);
  await stubTurnstile(page);
  await withAddress(page);
  await slowCode(page);
  // Not "load": that waits for the scripts held back above.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const before = page.url();
  const seen = carriers(page, "Early");

  await page.evaluate(() => {
    const name = document.getElementById("contact-name") as HTMLInputElement;
    // Nothing has taken over the form yet: its button is still off.
    if (!name.form?.querySelector("button[type=submit]:disabled")) {
      throw new Error("the form's code had already arrived");
    }
    name.value = "Early Typer";
    name.focus({ preventScroll: true });
    name.form?.requestSubmit();
  });
  await codeArrived(page);

  expect(page.url()).toBe(before);
  expect(new URL(page.url()).search).toBe("");
  expect(seen).toEqual([]);
  expect(posts).toHaveLength(0);
  await expect(page.getByLabel(/^Name/)).toHaveValue("Early Typer");
});

test("pressing Enter in a field before the form's code has arrived sends nothing and puts nothing in the address", async ({
  page,
}) => {
  const posts = contactPosts(page);
  await stubTurnstile(page);
  await withAddress(page);
  await slowCode(page);
  // Not "load": that waits for the scripts held back above.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const before = page.url();
  const seen = carriers(page, "Early");

  // What a person can do before the code arrives: focus a field, type, press
  // Enter. The button is off until then, so the browser does not submit.
  await page.locator("#contact-name").focus();
  await page.keyboard.type("Early Typer");
  await page.keyboard.press("Enter");
  await codeArrived(page);

  expect(page.url()).toBe(before);
  expect(new URL(page.url()).search).toBe("");
  expect(seen).toEqual([]);
  expect(posts).toHaveLength(0);
  await expect(page.getByLabel(/^Name/)).toHaveValue("Early Typer");
});

test("what was typed before the form's code arrived is kept when the code takes over, and is what gets sent", async ({
  page,
}) => {
  const posts = contactPosts(page);
  await stubTurnstile(page);
  await withAddress(page);
  await slowCode(page);
  // Not "load": that waits for the scripts held back above.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();

  await page.locator("#contact-name").focus();
  await page.keyboard.type(GOOD.name);
  await page.getByLabel(/^Email/).fill(GOOD.email);
  await page.getByLabel(/^Message/).fill(GOOD.body);
  await codeArrived(page);

  await expect(page.getByLabel(/^Name/)).toHaveValue(GOOD.name);
  await expect(page.getByLabel(/^Email/)).toHaveValue(GOOD.email);
  await expect(page.getByLabel(/^Message/)).toHaveValue(GOOD.body);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#contact-sent")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0].postData() ?? "{}")).toMatchObject({
    name: GOOD.name,
    email: GOOD.email,
    body: GOOD.body,
  });
});

test("the form page's policy lets Turnstile and the API in, and no other page's does", async ({
  request,
}) => {
  const policy = async (path: string) =>
    (await request.get(path)).headers()["content-security-policy"] ?? "";
  const home = await policy("/");
  expect(home).toContain("script-src 'self'");
  expect(home).toContain(" https://challenges.cloudflare.com");
  expect(home).toContain("frame-src https://challenges.cloudflare.com");
  expect(home).toContain(`connect-src 'self' ${API}`);
  expect(home).not.toContain("unsafe-inline");
  expect(home).not.toContain("unsafe-eval");
  expect(home).not.toMatch(/style-src[^;]*https:/);
  for (const path of [
    "/privacy",
    "/accessibility",
    "/security",
    "/projects",
    "/no-such-page",
  ]) {
    const other = await policy(path);
    expect(other, path).not.toContain("challenges.cloudflare.com");
    expect(other, path).not.toContain("frame-src");
    expect(other, path).toContain("connect-src 'self';");
  }
});

test("opening and using the form raises no policy violation and no hydration error", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      problems.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await open(page);
  await reach(page);
  await fill(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#contact-sent")).toBeVisible();

  expect(problems).toEqual([]);
});

// Accessibility, light and dark, at a phone and a laptop width, for every
// palette a visitor can pick. The form's colours are ink on the page colour,
// the pair every palette must pass, so this is the check that it does.
for (const width of [390, 1280]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on the form at ${width}px in ${scheme}, for every palette, with and without errors`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // No motion, so a section is not half way through fading in when it is checked.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await open(page);
      await reach(page);
      const ids =
        (await page.locator("html").getAttribute("data-palettes"))
          ?.split(" ")
          .filter(Boolean) ?? [];
      expect(ids.length).toBeGreaterThanOrEqual(2);

      for (const id of ids) {
        await page.evaluate((palette) => {
          document.documentElement.dataset.palette = palette;
        }, id);
        for (const state of ["clean", "errors"]) {
          if (state === "errors")
            await page.getByRole("button", { name: "Send message" }).click();
          const found = await new AxeBuilder({ page }).include(FORM).analyze();
          expect(found.violations, `${id} ${state}`).toEqual([]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
            `${id} ${state}: no sideways scroll`,
          ).toBeLessThanOrEqual(width);
        }
        await page.reload();
        await reach(page);
      }
    });
  }
}

// Not part of the normal run: it loads Cloudflare's real script, so it needs a
// network. It proves the page's policy is enough for the real widget, with no
// style or other violation. TURNSTILE_LIVE=1 npx playwright test e2e/contact.spec.ts
test("the real Turnstile script runs under the page's policy with no violation", async ({
  page,
}) => {
  test.skip(
    !process.env.TURNSTILE_LIVE,
    "needs the network; set TURNSTILE_LIVE=1",
  );
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.log(
        `VIOLATION ${event.violatedDirective} ${event.blockedURI} ${event.sample ?? ""}`,
      );
    });
  });
  page.on("console", (message) => {
    if (
      message.text().startsWith("VIOLATION") ||
      /Content Security Policy/i.test(message.text())
    ) {
      violations.push(message.text());
    }
  });
  await withAddress(page);
  await page.goto("/");
  await reach(page);
  await fill(page);
  const loaded = page.waitForResponse((response) =>
    response.url().includes("challenges.cloudflare.com"),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await loaded;
  // The real widget ran, gave the dummy token, and the message went through.
  await expect(page.locator("#contact-sent")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  expect(
    await page.locator("iframe[src*='challenges.cloudflare.com']").count(),
  ).toBeGreaterThanOrEqual(0);

  expect(violations).toEqual([]);
});
