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
// The API is on its own origin, as in production (see playwright.config.ts).
const API = "http://localhost:8100";
const BOOTSTRAP_TOKEN = "e2e-bootstrap-token";

let context: BrowserContext;
let page: Page;
let authenticator: CDPSession;

test.beforeAll(async ({ browser }) => {
  // In production Cloudflare Access adds this header at the edge, after the
  // browser's CORS checks, so it is added here on the way to the API too.
  const accessToken = readFileSync(TOKEN_FILE, "utf8").trim();
  context = await browser.newContext();
  await context.route(`${API}/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-access-jwt-assertion": accessToken },
    }),
  );
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
  const response = await request.get(`${API}/api/v1/admin/csrf`);

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

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const MARKDOWN_PAYLOAD =
  "<script>window.__xss=1</script> [click](javascript:window.__xss=1) **bold**";

async function expectNothingInjected() {
  const found = await page.evaluate(() => ({
    handlers: document.querySelectorAll("[onerror], [onload], [onclick]").length,
    scriptLinks: document.querySelectorAll('a[href^="javascript"]').length,
    images: document.querySelectorAll('img[src="x"]').length,
    ran: "__xss" in window,
  }));
  expect(found).toEqual({ handlers: 0, scriptLinks: 0, images: 0, ran: false });
}

test("script payloads in every project field stay plain text", async () => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto("/desk/sections");
  await page.getByLabel("Type").selectOption("projects");
  await page.getByLabel("Title").fill("Work");
  await page.getByRole("button", { name: "Add section" }).click();
  await page.getByRole("link", { name: "Work" }).click();

  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add item" }) });
  await form.getByLabel("Title").fill(PAYLOAD);
  await form.getByLabel("Short description").fill(MARKDOWN_PAYLOAD);
  await form.getByLabel("Category").fill(PAYLOAD.slice(0, 40));
  await form.getByLabel("Tags").fill(PAYLOAD.slice(0, 40));
  await form.getByRole("button", { name: "Add link" }).click();
  const links = form.getByRole("group", { name: /^Links/ });
  await links.getByLabel("Label").fill(PAYLOAD.slice(0, 60));
  await links.getByLabel("Address").fill("https://example.test/");
  await form.getByRole("button", { name: "Add field" }).click();
  const extra = form.getByRole("group", { name: /^Extra fields/ });
  await extra.getByLabel("Label").fill(PAYLOAD.slice(0, 60));
  await extra.getByLabel("Value").fill(PAYLOAD);
  await form.getByRole("button", { name: "Add image" }).click();
  await form.getByRole("group", { name: /^Images/ }).getByLabel("Alt text").fill(PAYLOAD);
  await form.getByLabel("Case study").fill(MARKDOWN_PAYLOAD);
  await form.getByRole("button", { name: "Add item" }).click();

  await expect(page.getByText("Item added.")).toBeVisible();
  const row = page.getByTestId("item-row");
  await expect(row.getByText(PAYLOAD)).toBeVisible();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const preview = row.getByRole("button", { name: "Preview" });
  await preview.first().click();
  await preview.last().click();
  const rendered = row.getByTestId("markdown-preview");
  await expect(rendered.first()).toContainText("<script>window.__xss=1</script>");
  await expect(rendered.first().locator("strong")).toHaveText("bold");
  await expect(rendered.first().locator("a")).toHaveCount(0);
  await expectNothingInjected();

  await page.reload();
  await expect(page.getByTestId("item-row").getByText(PAYLOAD)).toBeVisible();
  await expectNothingInjected();
  expect(dialogs).toEqual([]);
});

test("publishing text with contact details asks first", async () => {
  await page.getByTestId("item-row").getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByTestId("item-row").locator("form");
  await editor.getByLabel("Title").fill("Ledger");
  await editor.getByLabel("Short description").fill("Write to someone@example.test");
  await editor.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Item saved.")).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const warnings = page.getByTestId("privacy-warnings");
  await expect(warnings).toContainText("Ledger: summary: an email address someone@example.test");
  await page.getByRole("button", { name: "Go back and edit" }).click();
  await expect(page.getByTestId("publish-state")).toContainText("Never published.");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish anyway" }).click();
  await expect(page.getByText("Published.")).toBeVisible();
  await expect(page.getByTestId("publish-state")).toContainText("The live site shows this draft.");
});

test("the theme editor blocks colours that fail contrast", async () => {
  await page.goto("/desk/settings");
  const save = page.getByRole("button", { name: "Save theme" });

  await page.getByLabel("Light theme Text", { exact: true }).fill("#bbbbbb");
  await expect(page.getByTestId("contrast-failures")).toContainText(
    "Light theme: Text on the background is",
  );
  await expect(save).toBeDisabled();

  await page.getByRole("button", { name: "Blue" }).click();
  await expect(page.getByTestId("contrast-failures")).toHaveCount(0);
  await save.click();
  await expect(page.getByText("Theme saved.")).toBeVisible();
  await expect(page.getByLabel("Light theme Accent", { exact: true })).toHaveValue("#2a55c7");
});

const CAMERA_JPEG = resolve(__dirname, "fixtures/camera.jpg");

function itemTitles() {
  return page.getByTestId("item-row").locator(":scope > div:first-child > p > strong").allTextContents();
}

type PublicSite = {
  sections: Array<{ title: string; items: Array<{ data: { title: string; images: Array<{ media: string }> } }> }>;
  media: Record<string, { sources: Array<{ url: string }> }>;
};

test("media upload refuses a script and keeps no camera details", async () => {
  await page.goto("/desk/media");
  const upload = page.getByRole("button", { name: "Upload" });

  await page.getByLabel(/^Image/).setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("<script>window.__xss=1</script>"),
  });
  await page.getByLabel(/^Alt text/).fill("Not really a photo");
  await upload.click();
  await expect(page.getByText("Choose a JPEG, PNG or WebP image.")).toBeVisible();
  await expect(page.getByTestId("media-row")).toHaveCount(0);

  await page.getByLabel(/^Image/).setInputFiles(CAMERA_JPEG);
  await page.getByLabel(/^Alt text/).fill("");
  await upload.click();
  await expect(page.getByText("Describe the image for people who cannot see it.")).toBeVisible();

  await page.getByLabel(/^Alt text/).fill("Orange test card");
  await upload.click();
  await expect(page.getByText("Image added.")).toBeVisible();
  const row = page.getByTestId("media-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("thumbnail")).toHaveJSProperty("complete", true);

  await row.getByLabel("Alt text").fill("Orange card on a desk");
  await row.getByRole("button", { name: "Save alt text" }).click();
  await expect(page.getByText("Alt text saved.")).toBeVisible();
});

test("project items go through every step and the published copy is public", async () => {
  await page.goto("/desk/sections");
  await page.getByLabel("Type").selectOption("projects");
  await page.getByLabel("Title").fill("Showcase");
  await page.getByRole("button", { name: "Add section" }).click();
  await page.getByRole("link", { name: "Showcase" }).click();

  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add item" }) });
  for (const title of ["Ledger", "Notes"]) {
    await form.getByLabel("Title").fill(title);
    if (title === "Ledger") {
      await form.getByRole("button", { name: "Add image" }).click();
      const slot = form.getByRole("group", { name: /^Images/ });
      await slot.getByRole("button", { name: "Choose image" }).click();
      await slot.getByRole("button", { name: "Use Orange card on a desk" }).click();
      await expect(slot.getByTestId("thumbnail")).toHaveJSProperty("complete", true);
      await expect(slot.getByLabel("Alt text")).toHaveValue("Orange card on a desk");
    }
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(page.getByText("Item added.")).toBeVisible();
  }
  await expect.poll(itemTitles).toEqual(["Ledger", "Notes"]);

  // Edit
  await page.getByTestId("item-row").filter({ hasText: "Ledger" })
    .getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByTestId("item-row").filter({ hasText: "Ledger" }).locator("form");
  await editor.getByLabel("Title").fill("Ledger app");
  await editor.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Item saved.")).toBeVisible();

  // Reorder, hide, unhide
  await page.getByRole("button", { name: "Move Notes up" }).click();
  await expect.poll(itemTitles).toEqual(["Notes", "Ledger app"]);
  await page.getByRole("button", { name: "Hide Notes" }).click();
  await page.getByRole("button", { name: "Show Notes" }).click();
  await expect(page.getByRole("button", { name: "Hide Notes" })).toBeVisible();

  // Delete (to the trash) and restore
  await page.getByRole("button", { name: "Move Notes to the trash" }).click();
  await expect.poll(itemTitles).toEqual(["Ledger app"]);
  const editorUrl = page.url();
  await page.goto("/desk/trash");
  await page.getByRole("button", { name: "Restore Notes" }).click();
  await expect(page.getByText("“Notes” is back.")).toBeVisible();
  await page.goto(editorUrl);
  await expect.poll(itemTitles).toEqual(["Notes", "Ledger app"]);

  // Nothing is public before Publish
  const before = (await (await page.request.get(`${API}/api/v1/site`)).json()) as PublicSite;
  expect(before.sections.map((s) => s.title)).not.toContain("Showcase");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publish-state")).toContainText("The live site shows this draft.");
  // The API asked Pages to rebuild the site (the development deployer only logs).
  await expect(page.getByTestId("deploy-state")).toContainText("Last site build requested");

  const response = await page.request.get(`${API}/api/v1/site`);
  expect(response.headers()["cache-control"]).toContain("public");
  const site = (await response.json()) as PublicSite;
  const showcase = site.sections.find((s) => s.title === "Showcase");
  expect(showcase?.items.map((i) => i.data.title)).toEqual(["Notes", "Ledger app"]);
  const mediaId = showcase!.items[1].data.images[0].media;
  const image = await page.request.get(`${API}${site.media[mediaId].sources[0].url}`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/webp");
  expect((await image.body()).includes("SecretCam")).toBe(false);
});

test("the admin fits a phone screen", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/desk/sections", "/desk/settings", "/desk/trash", "/desk/audit"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(width, path).toBeLessThanOrEqual(390);
  }
});
