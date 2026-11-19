import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  type BrowserContext,
  type CDPSession,
  type Dialog,
  expect,
  type Page,
  type Response,
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

// api/tests/e2e_server.py publishes these so the site build has content.
const SEEDED_SECTIONS = [
  "Seeded",
  "About me",
  "Selected work",
  "Work history",
  "Study",
  "Toolkit",
  "Contact me",
  "Elsewhere",
];

async function rowTitles() {
  const titles = await page.getByTestId("section-row").getByRole("link").allTextContents();
  return titles.filter((title) => !SEEDED_SECTIONS.includes(title));
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

// The static export writes nested prefetch files where the client does not ask
// for them; scripts/flatten-segments.ts renames them. A Next upgrade that
// changes either side shows up here as a 404.
test("every prefetch the admin makes is found", async () => {
  const prefetches: { url: string; status: number }[] = [];
  const record = (response: Response) => {
    const request = response.request();
    const url = new URL(request.url());
    const prefetch =
      request.headers()["next-router-prefetch"] !== undefined ||
      /\/__next\.|\.txt$/.test(url.pathname);
    if (url.origin === new URL(page.url()).origin && prefetch) {
      prefetches.push({ url: url.pathname, status: response.status() });
    }
  };
  const nested = () => prefetches.some((p) => p.url.includes("__next.desk.sections"));
  const missing = () => prefetches.filter((p) => p.status === 404);
  page.on("response", record);
  for (const path of ["/desk", "/desk/media", "/desk/settings", "/desk/sections"]) {
    const before = prefetches.length;
    await page.goto(path);
    // Not networkidle: a prefetch that gets the 404 page never settles.
    await expect.poll(() => prefetches.length, { message: path }).toBeGreaterThan(before);
  }
  await page.getByRole("link", { name: "Beta" }).hover();
  await expect.poll(nested, { message: "nested prefetch requested" }).toBe(true);
  page.off("response", record);

  expect(missing()).toEqual([]);
  await page.getByRole("link", { name: "Beta" }).click();
  await page.waitForURL(/\/desk\/sections\/edit/);
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
  const record = (dialog: Dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  };
  page.on("dialog", record);
  await page.goto("/desk/sections");
  await page.getByLabel("Type").selectOption("projects");
  await page.getByLabel("Title").fill("Work");
  await page.getByRole("button", { name: "Add section" }).click();
  await page.getByRole("link", { name: "Work", exact: true }).click();

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
  page.off("dialog", record);
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

test("settings save with the palette choice in the draft", async () => {
  await page.goto("/desk/settings");
  await expect(page.getByRole("heading", { name: "Theme colours" })).toHaveCount(0);

  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(page.getByText("Some fields need changing.")).toHaveCount(0);
});

// Palettes. Preset A is the default for new settings.
const PRESET_A = "Ink and signal red";
const CUSTOM = "Signal custom";
let paletteEditor = "";

function slot(name: string) {
  return page.getByRole("group", { name: new RegExp(`^${name} `) });
}

function paletteRow(name: string) {
  return page.getByTestId("palette-row").filter({ has: page.getByText(name, { exact: true }) });
}

test("a preset is duplicated, then edited by hex field and by keyboard on the picker", async () => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) blocked.push(message.text());
  });
  await page.goto("/desk/settings");
  await expect(paletteRow(PRESET_A).getByText("Preset", { exact: true })).toBeVisible();
  await expect(paletteRow(PRESET_A).getByRole("link", { name: /^Edit/ })).toHaveCount(0);

  await page.getByRole("button", { name: `Duplicate to edit: ${PRESET_A}` }).click();

  await expect(page).toHaveURL(/\/desk\/settings\/palette\?id=/);
  const url = new URL(page.url());
  paletteEditor = url.pathname + url.search;
  await expect(page.getByRole("heading", { name: `Edit palette: ${PRESET_A} copy` })).toBeVisible();
  await expect(page.getByText("Changes reach visitors only after you publish.")).toBeVisible();
  await page.getByLabel("Palette name").fill(CUSTOM);

  const primary = slot("Light primary fill");
  await primary.getByLabel("Hex").fill("#b01e17");
  await expect(primary.getByLabel("Red")).toHaveValue("176");
  await expect(primary.getByLabel("Green")).toHaveValue("30");
  await primary.getByLabel("Blue").fill("24");
  await expect(primary.getByLabel("Hex")).toHaveValue("#B01E18");

  const accent = slot("Light accent 4");
  const before = await accent.getByLabel("Hex").inputValue();
  const swatch = accent.getByRole("button", { name: "Colour picker for Light accent 4" });
  await swatch.focus();
  await page.keyboard.press("Enter");
  await expect(swatch).toHaveAttribute("aria-expanded", "true");
  await expect(accent.getByRole("slider", { name: "Color" })).toBeFocused();
  // The picker's own style element ran under the CSP (it lays the picker out as flex).
  expect(await accent.locator(".react-colorful").evaluate((e) => getComputedStyle(e).display)).toBe("flex");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(accent.getByRole("slider", { name: "Hue" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(accent.getByLabel("Hex")).not.toHaveValue(before);
  await expect(page.getByTestId("save-state")).toHaveText("Unsaved changes");
  await expect(page.getByTestId("contrast-light")).not.toContainText("Fail");

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(swatch).toBeFocused();
  await expect(swatch).toHaveAttribute("aria-expanded", "false");

  const darker = await accent.getByLabel("Hex").inputValue();
  await page.getByRole("button", { name: "Save palette" }).click();
  await expect(page.getByText("Palette saved.")).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");

  await page.reload();
  await expect(slot("Light primary fill").getByLabel("Hex")).toHaveValue("#B01E18");
  await expect(slot("Light accent 4").getByLabel("Hex")).toHaveValue(darker);
  const variable = await page
    .getByTestId("preview-light")
    .evaluate((element) => (element as HTMLElement).style.getPropertyValue("--p-primary"));
  expect(variable).toBe("#B01E18");
  expect(blocked).toEqual([]);
});

test("the palette editor page has no colours in its built HTML", async ({ request }) => {
  const html = await (await request.get("/desk/settings/palette")).text();

  expect(html).not.toContain("--p-");
  expect(html).not.toMatch(/style="[^"]*#[0-9A-Fa-f]{6}/);
});

test("a failing pair shows the error and blocks save; leaving asks first", async () => {
  await page.goto(paletteEditor);
  const text = slot("Light text on primary");

  await text.getByLabel("Hex").fill("#B01E18");

  const message = "Light: on_primary on primary is 1.00:1; it needs at least 4.5:1.";
  await expect(text.getByText(message)).toBeVisible();
  await expect(slot("Light primary fill").getByText(message)).toBeVisible();
  await expect(text.getByLabel("Hex")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("contrast-light")).toContainText("Fail");
  await page.getByRole("button", { name: "Save palette" }).click();
  await expect(page.getByText(/^Nothing was saved\. 1 colour pair is too close/)).toBeVisible();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Back to settings" }).click();
  await expect(page).toHaveURL(/\/desk\/settings\/palette/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "Back to settings" }).click();
  await expect(page.getByRole("heading", { name: "Site settings" })).toBeVisible();

  await page.goto(paletteEditor);
  await expect(slot("Light text on primary").getByLabel("Hex")).toHaveValue("#FFFFFF");
});

test("palette mode, default and enabled list are saved to the draft", async () => {
  await page.goto("/desk/settings");
  await expect(page.getByRole("radio", { name: `Default: ${PRESET_A}` })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: `Enabled for visitors: ${PRESET_A}` })).toBeDisabled();
  await expect(page.getByText("Visitors start on the default and can choose")).toBeVisible();

  await page.getByRole("radio", { name: /Visitor picks/ }).check();
  await page.getByRole("checkbox", { name: "Enabled for visitors: Original" }).check();
  await page.getByRole("radio", { name: `Default: ${CUSTOM}` }).check();
  await expect(page.getByRole("checkbox", { name: `Enabled for visitors: ${CUSTOM}` })).toBeChecked();
  await expect(page.getByText("Unsaved changes to the palette choice.")).toBeVisible();
  await page.getByRole("button", { name: "Save palette choice" }).click();
  await expect(page.getByText("Palette choice saved.")).toBeVisible();
  await expect(page.getByTestId("publish-state")).not.toContainText("The live site shows this draft.");

  await page.reload();
  await expect(page.getByRole("radio", { name: /Visitor picks/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: `Default: ${CUSTOM}` })).toBeChecked();
  for (const name of [PRESET_A, "Original", CUSTOM]) {
    await expect(page.getByRole("checkbox", { name: `Enabled for visitors: ${name}` })).toBeChecked();
  }
  await expect(
    page.getByRole("checkbox", { name: "Enabled for visitors: Forest green and ink" }),
  ).not.toBeChecked();
});

test("a custom palette goes to the trash and comes back", async () => {
  await page.goto("/desk/settings");
  await page.getByRole("button", { name: `Delete: ${CUSTOM}` }).click();
  await expect(page.getByText("This palette is the default")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete: Original" })).toHaveCount(0);

  await page.getByRole("radio", { name: `Default: ${PRESET_A}` }).check();
  await page.getByRole("button", { name: "Save palette choice" }).click();
  await expect(page.getByText("Palette choice saved.")).toBeVisible();
  await page.getByRole("button", { name: `Delete: ${CUSTOM}` }).click();

  await expect(page.getByText(`“${CUSTOM}” moved to the trash.`)).toBeVisible();
  await expect(paletteRow(CUSTOM)).toHaveCount(0);
  await page.getByRole("button", { name: `Restore ${CUSTOM}` }).click();
  await expect(page.getByText(`“${CUSTOM}” is back.`)).toBeVisible();
  await expect(paletteRow(CUSTOM)).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: `Enabled for visitors: ${CUSTOM}` })).not.toBeChecked();

  await page.getByRole("button", { name: `Delete: ${CUSTOM}` }).click();
  await expect(paletteRow(CUSTOM)).toHaveCount(0);
  await page.goto("/desk/trash");
  await expect(page.getByTestId("trash-row").filter({ hasText: CUSTOM })).toContainText("Palette");
  await page.getByRole("button", { name: `Restore ${CUSTOM}` }).click();
  await expect(page.getByText(`“${CUSTOM}” is back.`)).toBeVisible();
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
  for (const path of ["/desk/sections", "/desk/settings", "/desk/trash", "/desk/audit", paletteEditor]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(width, path).toBeLessThanOrEqual(390);
  }
});
