import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { sendMessage } from "./fixtures/contact";

// The contacts, blocklist, delete-everything and limits steps of the admin
// suite. They run inside admin.spec.ts after the inbox steps, because that spec
// holds the one passkey and its session. Messages arrive through the real
// public route. The admin pages use their own light and dark colours, not the
// visitors' palettes, so colour contrast is checked in both schemes.

const tag = Math.random().toString(36).slice(2, 8);
const mail = (name: string) => `${name}.${tag}@example.com`;
const today = new Date().toISOString().slice(0, 10);

const DANA = { name: `Dana Dayton ${tag}`, email: mail("dana") };
const ERIN = { name: `Erin Eraser ${tag}`, email: mail("erin") };
const FAY = { name: `Fay Blocker ${tag}`, email: mail("fay") };
const HANA = { name: `Hana Holder ${tag}`, email: mail("hana") };
const ISLA = { name: `Isla Inspector ${tag}`, email: mail("isla") };
const KEPT_BLOCK = mail("kept");
const HASH_BLOCK = mail("hashonly");

const body = (text: string) => `${text} (${tag})`;

/** Ask for the passkey only if it was not confirmed in the last few minutes. */
async function confirmed(page: Page, done: Locator) {
  const dialog = page.getByRole("dialog", { name: "Confirm with your passkey" });
  await expect(dialog.or(done)).toBeVisible();
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Use passkey" }).click();
  }
  await expect(done).toBeVisible();
}

async function openMessage(page: Page, name: string, text = "") {
  await page.goto(`/desk/messages?q=${tag}`);
  await page
    .getByTestId("message-row")
    .filter({ hasText: text })
    .getByRole("link", { name })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: `Message from ${name}` })).toBeFocused();
}

async function openContact(page: Page, name: string) {
  await page.goto(`/desk/contacts?q=${tag}`);
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeFocused();
}

/** Tab through the controls in the page's main area: every one must be reached. */
async function reachableByKeyboard(page: Page, scope = "main") {
  const selector = `${scope} :is(a[href], button:not([disabled]), input:not([disabled]), select, textarea)`;
  await page.locator(selector).first().waitFor();
  await expect(page.getByText("Loading…")).toHaveCount(0);
  const total = await page.evaluate((s) => {
    const items = [...document.querySelectorAll(s)];
    (items[0] as HTMLElement).focus();
    return items.length;
  }, selector);
  const seen = new Set<number>([0]);
  for (let step = 0; step < total + 8 && seen.size < total; step++) {
    await page.keyboard.press("Tab");
    const index = await page.evaluate(
      (s) => [...document.querySelectorAll(s)].indexOf(document.activeElement as Element),
      selector,
    );
    if (index >= 0) seen.add(index);
  }
  expect(seen.size, `${scope}: every control can be reached with Tab`).toBe(total);
}

async function noSideways(page: Page, width: number, label: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    label,
  ).toBeLessThanOrEqual(width);
}

export function contactsTests(getPage: () => Page) {
  test.describe("contacts, blocklist, delete everything and limits", () => {
    test.describe.configure({ mode: "serial" });

    test("messages from the site arrive, one sender twice", async ({ request }) => {
      const sent = [
        await sendMessage(request, { ...DANA, body: body("First note from Dana about a role.") }),
        await sendMessage(request, { ...DANA, body: body("Second note from Dana, a week later.") }),
        await sendMessage(request, { ...ERIN, body: body("A message to be erased.") }),
        await sendMessage(request, { ...FAY, body: body("A message from someone to block.") }),
        await sendMessage(request, { ...HANA, body: body("A message from a contact to be erased.") }),
        await sendMessage(request, { ...ISLA, body: body("A message for the accessibility checks.") }),
      ];
      expect(sent.map((s) => s.status)).toEqual([201, 201, 201, 201, 201, 201]);
    });

    test("a message is saved as a contact, with the fields optional", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await openMessage(page, DANA.name, "First note");
      await expect(page.getByRole("link", { name: "Open the contact" })).toHaveCount(0);

      await page.getByRole("button", { name: "Save as contact" }).click();
      const form = page.getByRole("form", { name: "Save as contact" });
      await expect(form).toContainText("copied from this message");
      await form.getByLabel(/^Organisation/).fill("Halverton Recruitment");
      await form.getByLabel(/^Tags/).fill("recruiter, spring, recruiter");
      await form.getByLabel(/^Notes/).fill("Met at the careers fair.");
      await form.getByLabel(/^Follow-up date/).fill(today);
      await form.getByRole("button", { name: "Save contact" }).click();

      await expect(page.getByRole("status").filter({ hasText: "Saved as a contact." })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open the contact" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save as contact" })).toHaveCount(0);

      // A problem is shown on the field and nothing is saved.
      await openMessage(page, ERIN.name);
      await page.getByRole("button", { name: "Save as contact" }).click();
      const erin = page.getByRole("form", { name: "Save as contact" });
      await erin.getByLabel(/^Tags/).fill("x".repeat(31));
      await erin.getByRole("button", { name: "Save contact" }).click();
      await expect(erin.getByText("Keep each tag to 30 characters.")).toBeVisible();
      await expect(erin.getByLabel(/^Tags/)).toHaveAttribute("aria-invalid", "true");
      await erin.getByRole("button", { name: "Not now" }).click();
      await expect(page.getByRole("button", { name: "Save as contact" })).toBeVisible();
    });

    test("the contact opens, shows the email as text, and its edits are kept", async () => {
      const page = getPage();
      await openMessage(page, DANA.name, "First note");
      await page.getByRole("link", { name: "Open the contact" }).click();
      await expect(page.getByRole("heading", { level: 1, name: DANA.name })).toBeVisible();

      await expect(page.getByText(DANA.email)).toBeVisible();
      await expect(page.getByText("Email (cannot be changed)")).toBeVisible();
      await expect(page.locator(`input[value="${DANA.email}"]`)).toHaveCount(0);
      await expect(page.getByLabel(/^Organisation/)).toHaveValue("Halverton Recruitment");
      await expect(page.getByLabel(/^Tags/)).toHaveValue("recruiter, spring");
      await expect(page.getByLabel(/^Follow-up date/)).toHaveValue(today);
      await expect(page.getByTestId("linked-message")).toHaveCount(1);

      await page.getByLabel(/^Organisation/).fill("Halverton Group");
      await page.getByLabel(/^Notes/).fill("Wants a call in spring.");
      await page.getByRole("button", { name: "Save contact" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Contact saved." })).toBeVisible();

      await page.getByLabel(/^Follow-up date/).fill("2100-01-01");
      await page.getByRole("button", { name: "Save contact" }).click();
      await expect(page.getByText("Choose a date from 2000 to 2099.")).toBeVisible();

      await page.reload();
      await expect(page.getByLabel(/^Organisation/)).toHaveValue("Halverton Group");
      await expect(page.getByLabel(/^Notes/)).toHaveValue("Wants a call in spring.");
    });

    test("a message from the same sender is linked and unlinked", async () => {
      const page = getPage();
      await openContact(page, DANA.name);
      const linkable = page.getByTestId("linkable-message");
      await expect(linkable).toHaveCount(1);
      await expect(linkable).toContainText("Second note from Dana");

      await linkable.getByRole("button", { name: "Link this message" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Message linked." })).toBeVisible();
      await expect(page.getByTestId("linked-message")).toHaveCount(2);
      await expect(page.getByTestId("linkable-message")).toHaveCount(0);
      await expect(page.getByText("No other messages from this sender")).toBeVisible();

      const second = page.getByTestId("linked-message").filter({ hasText: "Second note from Dana" });
      await second.getByRole("link", { name: "Open this message" }).click();
      await expect(page.getByRole("heading", { name: `Message from ${DANA.name}` })).toBeFocused();
      await expect(page.getByRole("link", { name: "Open the contact" })).toBeVisible();

      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: DANA.name })).toBeVisible();
      await page
        .getByTestId("linked-message")
        .filter({ hasText: "Second note from Dana" })
        .getByRole("button", { name: "Unlink this message" })
        .click();
      await expect(page.getByRole("status").filter({ hasText: "Message unlinked." })).toBeVisible();
      await expect(page.getByTestId("linked-message")).toHaveCount(1);
      await expect(page.getByTestId("linkable-message")).toHaveCount(1);
    });

    test("the contacts list searches, filters by tag and by follow-up due, and keeps the filters in the address", async () => {
      const page = getPage();
      await page.goto(`/desk/contacts?q=${tag}`);
      await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
      const rows = page.getByTestId("contact-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(DANA.name);
      await expect(rows.first()).toContainText("Halverton Group");
      await expect(rows.first()).toContainText("Follow up");

      const search = page.getByRole("search", { name: "Search and filter contacts" });
      await search.getByLabel("Tag", { exact: true }).fill("spring");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(page).toHaveURL(/tag=spring/);
      await expect(rows).toHaveCount(1);

      await search.getByLabel("Tag", { exact: true }).fill("no-such-tag");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByText("No contacts match those filters.")).toBeVisible();

      await search.getByLabel("Tag", { exact: true }).fill("");
      await search.getByLabel(/^Follow-up due/).check();
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(page).toHaveURL(/due=1/);
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("due");

      await search.getByRole("button", { name: "Clear filters" }).click();
      await expect(page).not.toHaveURL(/q=|due=|tag=/);
    });

    test("an address is blocked with the address kept, and without", async () => {
      const page = getPage();
      await page.goto("/desk/blocklist");
      await expect(page.getByRole("heading", { level: 1, name: "Blocklist" })).toBeVisible();
      await expect(page.getByTestId("blocklist-size")).toContainText(/\d+ of 500 places in use/);
      const form = page.getByRole("form", { name: "Block an address" });
      const keep = form.getByLabel(/^Keep the address so I can see it later/);
      await expect(keep).not.toBeChecked();

      // A bad address and an address in the note are refused on the page.
      await form.getByLabel("Email address to block").fill("not-an-address");
      await form.getByLabel(/^Note/).fill(`write to a@b.c ${tag}`);
      await form.getByRole("button", { name: "Block this address" }).click();
      await expect(form.getByText("Enter a full email address.")).toBeVisible();
      await expect(form.getByText("Leave email addresses out of notes.")).toBeVisible();

      await form.getByLabel("Email address to block").fill(HASH_BLOCK);
      await form.getByLabel(/^Note/).fill(`Hash only ${tag}`);
      await form.getByRole("button", { name: "Block this address" }).click();
      await confirmed(page, page.getByRole("status").filter({ hasText: "Address blocked." }));

      await form.getByLabel("Email address to block").fill(KEPT_BLOCK);
      await form.getByLabel(/^Note/).fill(`Kept ${tag}`);
      await keep.check();
      await form.getByRole("button", { name: "Block this address" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Address blocked." })).toBeVisible();
      await expect(keep).not.toBeChecked();

      const hashOnly = page.getByTestId("block-row").filter({ hasText: `Hash only ${tag}` });
      const kept = page.getByTestId("block-row").filter({ hasText: `Kept ${tag}` });
      await expect(hashOnly).toContainText("Address not kept (scrambled hash only)");
      await expect(hashOnly).not.toContainText(HASH_BLOCK);
      await expect(hashOnly).toContainText("Messages stopped");
      await expect(kept).toContainText(KEPT_BLOCK);
      await expect(kept).toContainText("Blocks until");

      await page.reload();
      await expect(page.getByTestId("block-row").filter({ hasText: KEPT_BLOCK })).toHaveCount(1);
      await expect(page.getByText(HASH_BLOCK)).toHaveCount(0);
    });

    test("a block is renewed and removed", async () => {
      const page = getPage();
      await page.goto("/desk/blocklist");
      const kept = page.getByTestId("block-row").filter({ hasText: `Kept ${tag}` });
      await kept.getByRole("button", { name: "Renew" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Block renewed." })).toBeVisible();

      await kept.getByRole("button", { name: "Remove" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Block removed." })).toBeVisible();
      await expect(page.getByTestId("block-row").filter({ hasText: `Kept ${tag}` })).toHaveCount(0);
      await expect(page.getByTestId("block-row").filter({ hasText: `Hash only ${tag}` })).toHaveCount(1);
    });

    test("a sender is blocked from a message, which moves to spam", async () => {
      const page = getPage();
      await openMessage(page, FAY.name);
      await page.getByRole("button", { name: "Block sender" }).click();
      const form = page.getByRole("form", { name: "Block sender" });
      await expect(form).toContainText("moves to spam");
      const keep = form.getByLabel(/^Keep the address so I can see it later/);
      await expect(keep).not.toBeChecked();

      await form.getByLabel(/^Note/).fill("a@b.c");
      await form.getByRole("button", { name: "Block this sender" }).click();
      await expect(form.getByText("Leave email addresses out of notes.")).toBeVisible();

      await form.getByLabel(/^Note/).fill(`From a message ${tag}`);
      await keep.check();
      await form.getByRole("button", { name: "Block this sender" }).click();
      await confirmed(
        page,
        page.getByRole("status").filter({ hasText: "Sender blocked. This message was moved to spam." }),
      );
      await expect(page.getByText("This message was held back by the spam checks.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Not spam" })).toBeVisible();

      await page.goto("/desk/blocklist");
      const row = page.getByTestId("block-row").filter({ hasText: `From a message ${tag}` });
      await expect(row).toContainText(FAY.email);
    });

    test("delete everything from a message shows what was stored, then it is cancelled", async () => {
      const page = getPage();
      await openMessage(page, ERIN.name);
      await expect(page.getByTestId("erase-warning")).toHaveText(
        "Without 'also block', this also removes the block on this address if there is one.",
      );
      const also = page.getByRole("checkbox", { name: /^Also block this sender/ });
      await expect(also).not.toBeChecked();

      await page.getByRole("button", { name: "Delete everything about this email" }).click();
      const requested = page.getByTestId("erase-requested");
      await confirmed(page, requested);
      await expect(requested).toContainText("1 message, 0 notes and 0 saved contacts");
      await expect(requested).toContainText("any existing block on this address goes too");
      await expect(requested).toContainText("waits 24 hours");
      // Nothing has been removed yet.
      await expect(page.getByText(body("A message to be erased."))).toBeVisible();

      await requested.getByRole("link", { name: "Review pending actions" }).click();
      const row = page.getByTestId("pending-row").filter({ hasText: "Delete everything about one email address" });
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("erase-summary")).toContainText("1 message, 0 notes and 0 saved contacts");
      await expect(row).not.toContainText("erase_sender");
      await row.getByRole("button", { name: "Cancel this action" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Cancelled. Nothing was changed." })).toBeVisible();
      await expect(page.getByTestId("pending-row")).toHaveCount(0);
      await openMessage(page, ERIN.name);
      await expect(page.getByText(body("A message to be erased."))).toBeVisible();
    });

    test("delete everything from a contact with also block is asked for, and stays pending", async () => {
      const page = getPage();
      await openMessage(page, HANA.name);
      await page.getByRole("button", { name: "Save as contact" }).click();
      await page.getByRole("button", { name: "Save contact" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Saved as a contact." })).toBeVisible();
      await page.getByRole("link", { name: "Open the contact" }).click();
      await expect(page.getByRole("heading", { level: 1, name: HANA.name })).toBeVisible();

      await expect(page.getByTestId("erase-warning")).toContainText("Without 'also block'");
      await page.getByRole("checkbox", { name: /^Also block this sender/ }).check();
      await page.getByRole("button", { name: "Delete everything about this email" }).click();
      const requested = page.getByTestId("erase-requested");
      await confirmed(page, requested);
      await expect(requested).toContainText("1 message, 0 notes and 1 saved contact");
      await expect(requested).toContainText("also keep the sender blocked");

      await page.goto("/desk/pending");
      const row = page.getByTestId("pending-row").filter({ hasText: "Delete everything about one email address" });
      await expect(row.getByTestId("erase-summary")).toContainText("1 message, 0 notes and 1 saved contact");
      await expect(row.getByTestId("erase-summary")).toContainText("also keep the sender blocked");
    });

    test("an editable limit is checked, saved with the passkey and kept after a reload", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/desk/settings");
      const card = page.getByRole("region", { name: "Contact form limits" });
      const months = card.getByLabel("Months a block lasts");
      await expect(months).toHaveValue("12");
      await expect(card.getByText("From 1 to 36. Default 12.")).toBeVisible();
      await expect(card.getByText("Blocklist size (entries that still block)")).toBeVisible();
      await expect(card.getByText("Wait before a vital action can run")).toBeVisible();
      await expect(card.getByText("24 hours").first()).toBeVisible();

      await months.fill("37");
      await card.getByRole("button", { name: "Save limits" }).click();
      await expect(card.getByText("Use a number from 1 to 36.")).toBeVisible();
      await expect(months).toHaveAttribute("aria-invalid", "true");
      await months.fill("1.5");
      await card.getByRole("button", { name: "Save limits" }).click();
      await expect(card.getByText("Enter a whole number.")).toBeVisible();

      await months.fill("18");
      await card.getByRole("button", { name: "Save limits" }).click();
      await confirmed(page, card.getByText("Limits saved."));

      await page.reload();
      await expect(card.getByLabel("Months a block lasts")).toHaveValue("18");
      await card.getByLabel("Months a block lasts").fill("12");
      await card.getByRole("button", { name: "Save limits" }).click();
      await expect(card.getByText("Limits saved.")).toBeVisible();
    });

    test("every new control can be used with the keyboard", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.goto(`/desk/contacts?q=${tag}`);
      await reachableByKeyboard(page);
      const search = page.getByLabel("Search name, organisation or email");
      await search.focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.type(DANA.name.split(" ")[0]);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/q=Dana/);
      const due = page.getByLabel(/^Follow-up due/);
      await due.focus();
      await page.keyboard.press("Space");
      await expect(due).toBeChecked();
      await page.getByRole("button", { name: "Apply" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/due=1/);

      await page.goto("/desk/blocklist");
      await reachableByKeyboard(page);
      const keep = page.getByLabel(/^Keep the address so I can see it later/);
      await keep.focus();
      await page.keyboard.press("Space");
      await expect(keep).toBeChecked();
      await page.keyboard.press("Space");
      await expect(keep).not.toBeChecked();

      await openMessage(page, ISLA.name);
      await reachableByKeyboard(page);
      const save = page.getByRole("button", { name: "Save as contact" });
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("form", { name: "Save as contact" })).toBeVisible();
      await page.getByRole("button", { name: "Not now" }).focus();
      await page.keyboard.press("Enter");
      await expect(save).toBeVisible();
      const block = page.getByRole("button", { name: "Block sender" });
      await block.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("form", { name: "Block sender" })).toBeVisible();
      await page.getByRole("form", { name: "Block sender" }).getByRole("button", { name: "Not now" }).focus();
      await page.keyboard.press("Enter");
      await expect(block).toBeVisible();
      const also = page.getByRole("checkbox", { name: /^Also block this sender/ });
      await also.focus();
      await page.keyboard.press("Space");
      await expect(also).toBeChecked();

      await page.goto("/desk/settings");
      await reachableByKeyboard(page, '[aria-labelledby="limits-title"]');
    });

    test("the new pages and cards have no accessibility violations at 390 and 1280 px, in both colour schemes", async () => {
      const page = getPage();
      const checks: Array<[string, (p: Page) => Promise<void>]> = [
        [
          "contacts list",
          async (p) => {
            await p.goto(`/desk/contacts?q=${tag}`);
            await expect(p.getByTestId("contact-row").first()).toBeVisible();
          },
        ],
        [
          "contact",
          async (p) => {
            await openContact(p, DANA.name);
            await expect(p.getByTestId("linked-message").first()).toBeVisible();
          },
        ],
        [
          "blocklist",
          async (p) => {
            await p.goto("/desk/blocklist");
            await expect(p.getByTestId("block-row").first()).toBeVisible();
          },
        ],
        [
          "limits card",
          async (p) => {
            await p.goto("/desk/settings");
            await expect(p.getByRole("region", { name: "Contact form limits" }).getByLabel("Months a block lasts")).toBeVisible();
          },
        ],
        [
          "message with the contact, block and erase panels open",
          async (p) => {
            await openMessage(p, ISLA.name);
            await p.getByRole("button", { name: "Save as contact" }).click();
            await p.getByRole("button", { name: "Block sender" }).click();
            await expect(p.getByRole("form", { name: "Block sender" })).toBeVisible();
          },
        ],
        [
          "pending actions with a delete-everything request",
          async (p) => {
            await p.goto("/desk/pending");
            await expect(p.getByTestId("erase-summary")).toBeVisible();
          },
        ],
      ];
      for (const width of [390, 1280]) {
        for (const scheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          for (const [name, open] of checks) {
            await open(page);
            const label = `${name} at ${width}px, ${scheme}`;
            await noSideways(page, width, label);
            const found = await new AxeBuilder({ page }).analyze();
            expect(found.violations, label).toEqual([]);
          }
        }
      }
      await page.emulateMedia({ colorScheme: null });
    });

    test("the waiting delete-everything request is cancelled from the pending page", async () => {
      const page = getPage();
      await page.goto("/desk/pending");
      const row = page.getByTestId("pending-row").filter({ hasText: "Delete everything about one email address" });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Cancel this action" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Cancelled. Nothing was changed." })).toBeVisible();
      await expect(page.getByText("Nothing is waiting.")).toBeVisible();
    });

    test("a contact is deleted with the passkey and its messages stay", async () => {
      const page = getPage();
      await openContact(page, DANA.name);
      await page.getByRole("button", { name: "Delete this contact" }).click();
      await expect(page.getByText("Its messages stay in the inbox.")).toBeVisible();
      await page.getByRole("button", { name: "Keep it" }).click();
      await expect(page.getByRole("button", { name: "Delete this contact" })).toBeVisible();

      await page.getByRole("button", { name: "Delete this contact" }).click();
      await page.getByRole("button", { name: "Delete this contact" }).click();
      const done = page.getByRole("status").filter({ hasText: "Contact deleted. Its messages were kept." });
      await confirmed(page, done);
      await expect(page).not.toHaveURL(/notice=/);
      await expect(page.getByTestId("contact-row").filter({ hasText: DANA.name })).toHaveCount(0);

      await openMessage(page, DANA.name, "First note");
      await expect(page.getByRole("button", { name: "Save as contact" })).toBeVisible();
      await expect(page.getByText(body("First note from Dana about a role."))).toBeVisible();
    });
  });
}
