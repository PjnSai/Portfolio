import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";

// One owner, one browser, one passkey: the steps build on each other.
test.describe.configure({ mode: "serial" });

const TOKEN_FILE = resolve(__dirname, "../../api/.e2e-access-token");
const BOOTSTRAP_TOKEN = "e2e-bootstrap-token";

let context: BrowserContext;
let page: Page;
let authenticator: CDPSession;

test.beforeAll(async ({ browser }) => {
  // Cloudflare Access adds this header to every request in production.
  const accessToken = readFileSync(TOKEN_FILE, "utf8").trim();
  context = await browser.newContext({
    extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": accessToken },
  });
  page = await context.newPage();
  authenticator = await context.newCDPSession(page);
  await authenticator.send("WebAuthn.enable");
  await authenticator.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
});

test.afterAll(async () => {
  await context.close();
});

async function signIn() {
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
}

function rowTitles() {
  return page.getByTestId("section-row").getByRole("link").allTextContents();
}

test("admin pages are not indexed and the public page does not link to them", async ({
  request,
}) => {
  const admin = await request.get("/desk/sections");
  const home = await request.get("/");

  expect(admin.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(await admin.text()).toContain('name="robots" content="noindex');
  expect(await home.text()).not.toContain("/desk");
});

test("admin API refuses a request without the Access token", async ({
  request,
}) => {
  const response = await request.get("/api/v1/admin/csrf");

  expect(response.status()).toBe(403);
});

test("first passkey shows the recovery key once, then signs in", async () => {
  await page.goto("/desk/setup");
  await page.getByLabel("Set-up token").fill(BOOTSTRAP_TOKEN);
  await page.getByRole("button", { name: "Create passkey" }).click();

  const key = page.getByTestId("recovery-key");
  await expect(key).toHaveText(/^[A-Za-z0-9_-]{40,}$/);
  const continueLink = page.getByRole("link", { name: "Continue to sign in" });
  await expect(continueLink).toHaveAttribute("aria-disabled", "true");
  await page.getByLabel("I have stored the recovery key").check();
  await continueLink.click();

  await signIn();

  await page.goto("/desk/setup");
  await page.getByLabel("Set-up token").fill(BOOTSTRAP_TOKEN);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByText(/Set-up is closed/)).toBeVisible();
  await expect(page.getByTestId("recovery-key")).toHaveCount(0);
});

test("sign out, then sign in again with the passkey", async () => {
  await page.goto("/desk/security");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with passkey" }),
  ).toBeVisible();

  await signIn();
});

test("sections can be added, reordered and hidden", async () => {
  await page.goto("/desk/sections");
  for (const title of ["Alpha", "Beta"]) {
    await page.getByLabel("Type").selectOption("text");
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Add section" }).click();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  }
  expect(await rowTitles()).toEqual(["Alpha", "Beta"]);

  await page.getByRole("button", { name: "Move Beta up" }).click();
  await expect.poll(rowTitles).toEqual(["Beta", "Alpha"]);

  await page.getByRole("button", { name: "Hide Alpha" }).click();
  await expect(page.getByRole("button", { name: "Show Alpha" })).toBeVisible();

  await page.reload();
  await expect.poll(rowTitles).toEqual(["Beta", "Alpha"]);
  const alpha = page.getByTestId("section-row").filter({ hasText: "Alpha" });
  await expect(alpha.getByTestId("visibility")).toHaveText("Hidden");
});

test("a vital action needs the passkey, waits, and can be cancelled", async () => {
  await page.goto("/desk/sections");
  await page.getByRole("button", { name: "Move Alpha to the trash" }).click();
  await expect(page.getByRole("link", { name: "Alpha" })).toHaveCount(0);

  await page.getByRole("link", { name: "Trash" }).click();
  await page.getByRole("button", { name: "Delete Alpha for good" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm with your passkey" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();

  await expect(page.getByText("1 vital action is waiting.")).toBeVisible();
  await page.getByRole("link", { name: "Review pending actions" }).click();
  const action = page.getByTestId("pending-row");
  await expect(action).toContainText("Delete a section for good");
  await expect(action.getByTestId("time-left")).toHaveText(
    /Can run in (23 h 5\d|24 h 0) min\./,
  );

  await action.getByRole("button", { name: "Cancel this action" }).click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByText("1 vital action is waiting.")).toHaveCount(0);

  await page.getByRole("link", { name: "Trash" }).click();
  await expect(page.getByTestId("trash-row")).toContainText("Alpha");
});

test("the audit log lists the actions and can show flagged ones only", async () => {
  await page.goto("/desk/audit");
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  await expect(page.getByText("section trashed")).toBeVisible();

  await page.getByLabel("Flagged security events only").check();
  await expect(page.getByText("vital action requested")).toBeVisible();
  await expect(page.getByText("section trashed")).toHaveCount(0);
});

test("the admin fits a phone screen", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/desk/sections", "/desk/trash", "/desk/audit"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(width, path).toBeLessThanOrEqual(390);
  }
});
