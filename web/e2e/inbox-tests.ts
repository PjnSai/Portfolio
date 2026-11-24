import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { sendMessage } from "./fixtures/contact";

// The inbox steps of the admin suite. They run inside admin.spec.ts, after the
// owner has signed in, because that spec holds the one passkey and its session.
// Messages are sent through the real public route, so this also covers a
// message arriving from the site and showing up for the owner.

const PEOPLE = [
  {
    name: "Alice Archer",
    reason: "hiring",
    body: "Hello, I would like to discuss a graduate role with you.",
  },
  {
    name: "Bruno Baker",
    reason: "project",
    body: "Hi, we have a short project that might suit your skills.",
  },
  {
    name: "Chen Cole",
    reason: "other",
    body: "Good afternoon, are you free for a call about an internship?",
  },
];
const SPAMMERS = [
  {
    name: "Dull Spammer",
    body: "Cheap watches for sale today, buy a dozen right now.",
  },
  {
    name: "Eager Spammer",
    body: "You have won a prize, claim it before the end of today.",
  },
];

const run = Date.now().toString(36);

function email(name: string) {
  return `${name.split(" ")[0].toLowerCase()}.${run}@example.com`;
}

// This run's messages only: the public form tests send real messages to the
// same inbox, at the same time, so the page is always looked at through the
// search for this run's tag (the folder links keep it) and counts are asked of
// the API with the same search.
const LIST = `/desk/messages?q=${run}`;

async function folderCount(page: Page, folder: string) {
  const status = folder === "Inbox" ? "" : `&status=${folder.toLowerCase()}`;
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    return ((await response.json()) as { count: number }).count;
  }, `http://localhost:8100/api/v1/admin/messages?q=${run}${status}`);
}

async function noHorizontalScroll(page: Page, width: number) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
}

export function inboxTests(getPage: () => Page) {
  test.describe("inbox", () => {
    test.describe.configure({ mode: "serial" });

    test("messages sent from the site reach the inbox, and quarantine looks the same to the sender", async ({
      request,
    }) => {
      const answers = [];
      for (const person of PEOPLE) {
        answers.push(
          await sendMessage(request, {
            ...person,
            body: `${person.body} (${run})`,
            email: email(person.name),
          }),
        );
      }
      for (const person of SPAMMERS) {
        answers.push(
          await sendMessage(request, {
            ...person,
            body: `${person.body} (${run})`,
            email: email(person.name),
            website: "http://spam.example",
          }),
        );
      }

      expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    });

    test("the list shows the messages newest first, with a count on each folder", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(LIST);

      await expect(
        page.getByRole("heading", { level: 1, name: "Messages" }),
      ).toBeVisible();
      const rows = page.getByTestId("message-row");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("Chen Cole");
      await expect(rows.nth(2)).toContainText("Alice Archer");
      await expect(rows.first()).toContainText("New");
      expect(await folderCount(page, "Inbox")).toBe(3);
      expect(await folderCount(page, "New")).toBe(3);
      expect(await folderCount(page, "Spam")).toBe(2);
      await expect(
        page
          .getByRole("navigation", { name: "Message folders" })
          .getByRole("link", {
            name: /^Inbox/,
          }),
      ).toHaveAttribute("aria-current", "page");
      await expect(page.getByText("Dull Spammer")).toHaveCount(0);
    });

    test("opening a message shows it, marks it read and puts focus on its heading", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: "Alice Archer" }).click();

      const heading = page.getByRole("heading", {
        name: "Message from Alice Archer",
      });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.getByText(PEOPLE[0].body)).toBeVisible();
      await expect(page.getByText("Email (UNVERIFIED)")).toBeVisible();
      await expect(page.getByText(email("Alice Archer"))).toBeVisible();
      const reply = page.getByRole("link", { name: "Reply by email" });
      await expect(reply).toHaveAttribute(
        "href",
        `mailto:${email("Alice Archer")}?subject=Re%3A%20your%20message`,
      );

      await page.getByRole("link", { name: "Back to Inbox" }).click();
      await expect(page.getByTestId("message-row")).toHaveCount(3);
      expect(await folderCount(page, "New")).toBe(2);
      expect(await folderCount(page, "Read")).toBe(1);
    });

    test("a note is added, announced and kept in order; an empty note is refused", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: "Alice Archer" }).click();
      await expect(
        page.getByRole("heading", { name: "Message from Alice Archer" }),
      ).toBeFocused();

      await page.getByRole("button", { name: "Add note" }).click();
      const box = page.getByRole("textbox", { name: /^Note/ });
      await expect(page.getByText("Write a note first.")).toBeVisible();
      await expect(box).toHaveAttribute("aria-invalid", "true");
      await expect(box).toBeFocused();

      await box.fill("Rang back and left a message.");
      await page.getByRole("button", { name: "Add note" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Note added." }),
      ).toBeVisible();
      await expect(box).toHaveValue("");
      await expect(box).toBeFocused();
      await box.fill("Second note, after lunch.");
      await page.getByRole("button", { name: "Add note" }).click();
      await expect(page.getByTestId("note")).toHaveCount(2);
      await expect(page.getByTestId("note").first()).toContainText(
        "Rang back and left a message.",
      );
      await expect(page.getByTestId("note").nth(1)).toContainText(
        "Second note, after lunch.",
      );

      // The note is still there after a reload, and there is no way to change it.
      await page.reload();
      await expect(page.getByTestId("note")).toHaveCount(2);
      await expect(page.getByTestId("note").getByRole("button")).toHaveCount(0);
    });

    test("logging a response adds a note of its own kind and marks the message replied", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: "Bruno Baker" }).click();
      await expect(
        page.getByRole("heading", { name: "Message from Bruno Baker" }),
      ).toBeFocused();

      await page
        .getByRole("textbox", { name: /^Note/ })
        .fill("Sent the full CV by email.");
      await page.getByRole("button", { name: "Log response" }).click();

      await expect(
        page.getByRole("status").filter({
          hasText: "Response logged. The message is marked as replied.",
        }),
      ).toBeVisible();
      const note = page.getByTestId("note");
      await expect(note).toContainText("Responded with details");
      await expect(note).toContainText("Sent the full CV by email.");
      await expect(
        page.getByRole("heading", { name: "Message from Bruno Baker" }),
      ).toBeFocused();
      await page.getByRole("link", { name: "Back to Inbox" }).click();
      expect(await folderCount(page, "Replied")).toBe(1);
    });

    test("keep is a toggle with a clear state", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: "Chen Cole" }).click();
      const keep = page.getByRole("button", { name: "Keep this message" });
      await expect(keep).toHaveAttribute("aria-pressed", "false");
      await keep.click();
      await expect(
        page.getByText("Kept: it will not be removed automatically."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Kept: release it/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: /^Kept: release it/ }).click();
      await expect(page.getByText("No longer kept.")).toBeVisible();
    });

    test("deleting asks first, needs the passkey, waits 24 hours and can be cancelled", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: "Bruno Baker" }).click();
      await expect(
        page.getByRole("heading", { name: "Message from Bruno Baker" }),
      ).toBeFocused();

      const ask = page.getByRole("button", { name: "Delete for good" });
      await ask.focus();
      await page.keyboard.press("Enter");
      const group = page.getByRole("group", {
        name: "Delete this message for good?",
      });
      await expect(group).toBeVisible();
      await expect(group).toContainText("24 hours");
      await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(group).toHaveCount(0);
      await expect(ask).toBeFocused();

      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Request deletion" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Confirm with your passkey",
      });
      const pending = page.getByTestId("deletion-pending");
      // The passkey is asked for only if it was not confirmed in the last few
      // minutes, so either may come first.
      await expect(dialog.or(pending)).toBeVisible();
      if (await dialog.isVisible()) {
        await dialog.getByRole("button", { name: "Use passkey" }).click();
      }
      await expect(pending).toBeVisible();
      await expect(pending).toContainText("Deletion requested");
      await expect(pending).toContainText(
        /It can run in (23 h 5\d|24 h 0) min\./,
      );
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Deletion requested. It waits 24 hours" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete for good" }),
      ).toHaveCount(0);
      // Nothing has been removed: the message and its text are still here.
      await expect(page.getByText(PEOPLE[1].body)).toBeVisible();

      // It shows in the pending list too, and a reload still shows it here.
      await page.reload();
      await expect(page.getByTestId("deletion-pending")).toBeVisible();

      await page.getByRole("button", { name: "Cancel deletion" }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Deletion cancelled. The message is unchanged." }),
      ).toBeVisible();
      await expect(page.getByTestId("deletion-pending")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Delete for good" }),
      ).toBeFocused();

      await page.goto("/desk/pending");
      await expect(page.getByText("Nothing is waiting.")).toBeVisible();
      await page.goto(LIST);
      await expect(page.getByTestId("message-row")).toHaveCount(3);
    });

    test("search and the reason and date filters narrow the list and keep the folder counts", async () => {
      const page = getPage();
      await page.goto(LIST);
      const rows = page.getByTestId("message-row");
      await expect(rows).toHaveCount(3);
      // Every row says the address is unverified, and shows a spam score and a reason.
      await expect(rows.first()).toContainText("Unverified");
      await expect(rows.first()).toContainText("Spam score 0 of 100");
      await expect(rows.first()).toContainText("Other");

      const search = page.getByRole("search", {
        name: "Search and filter messages",
      });
      await search
        .getByLabel("Search name, email or message")
        .fill("graduate role");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Alice Archer");
      await expect(page).toHaveURL(/q=graduate\+role/);
      expect(await folderCount(page, "Inbox")).toBe(3);

      await search.getByLabel("Search name, email or message").fill(run);
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(3);

      await search.getByLabel("Reason").selectOption("project");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Bruno Baker");

      await search.getByLabel("Reason").selectOption("");
      const today = new Date().toISOString().slice(0, 10);
      await search.getByLabel("Received from").fill("2999-01-01");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(
        page.getByText("No messages match those filters."),
      ).toBeVisible();
      await search.getByLabel("Received from").fill(today);
      await search.getByLabel("Received to").fill(today);
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(3);

      // A first day after the last day is refused on the page, with words.
      await search.getByLabel("Received from").fill("2999-01-02");
      await search.getByLabel("Received to").fill("2999-01-01");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(
        page.getByText("The first day must not be after the last day."),
      ).toBeVisible();
      await search.getByLabel("Received from").fill("");
      await search.getByLabel("Received to").fill("");
      await search.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(3);

      // Clear filters takes every filter out of the address.
      await search.getByRole("button", { name: "Clear filters" }).click();
      await expect(page).not.toHaveURL(/q=/);
      await expect(
        page.getByRole("button", { name: "Clear filters" }),
      ).toHaveCount(0);
    });

    test("the spam tab lists held-back messages, and Not spam moves one to the inbox", async () => {
      const page = getPage();
      await page.goto(LIST);
      await page.getByRole("link", { name: /^Spam/ }).click();

      await expect(page).toHaveURL(/status=spam/);
      await expect(page.getByTestId("message-row")).toHaveCount(2);
      await expect(
        page.getByText("held back by the spam checks").first(),
      ).toBeVisible();
      await page.getByRole("link", { name: "Dull Spammer" }).click();

      await expect(
        page.getByRole("heading", { name: "Message from Dull Spammer" }),
      ).toBeFocused();
      await expect(
        page.getByText("This message was held back by the spam checks."),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Reply by email" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Log response" }),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Not spam" }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Moved to the inbox as a new message." }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Reply by email" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Not spam" })).toHaveCount(
        0,
      );

      await page.getByRole("link", { name: /^Back to/ }).click();
      await expect(page.getByTestId("message-row")).toHaveCount(1);
      await page.goto(LIST);
      expect(await folderCount(page, "Inbox")).toBe(4);
      expect(await folderCount(page, "Spam")).toBe(1);
    });

    test("message retention is edited in settings, checked, saved and kept after a reload", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/desk/settings");
      const card = page.getByRole("region", { name: "Message retention" });
      const spam = card.getByLabel("Spam: days to keep");
      const other = card.getByLabel("Other messages: days to keep");
      await expect(spam).toHaveValue("30");
      await expect(other).toHaveValue("365");

      await spam.fill("6");
      await card.getByRole("button", { name: "Save retention" }).click();
      await expect(
        card.getByText("Use between 7 and 3650 days."),
      ).toBeVisible();
      await expect(spam).toHaveAttribute("aria-invalid", "true");
      await spam.fill("abc");
      await card.getByRole("button", { name: "Save retention" }).click();
      await expect(
        card.getByText("Enter a whole number of days."),
      ).toBeVisible();

      await spam.fill("7");
      await other.fill("180");
      await card.getByRole("button", { name: "Save retention" }).click();
      // Saving needs a passkey confirmed in the last few minutes.
      const dialog = page.getByRole("dialog", {
        name: "Confirm with your passkey",
      });
      const saved = card.getByText(/Retention saved/);
      await expect(dialog.or(saved)).toBeVisible();
      if (await dialog.isVisible()) {
        await dialog.getByRole("button", { name: "Use passkey" }).click();
      }
      await expect(saved).toBeVisible();

      await page.reload();
      await expect(card.getByLabel("Spam: days to keep")).toHaveValue("7");
      await expect(card.getByLabel("Other messages: days to keep")).toHaveValue(
        "180",
      );
      // The periods are private: they are not part of the public site.
      const site = await page.request.get("http://localhost:8100/api/v1/site");
      expect(await site.text()).not.toContain("retention");
    });

    test("the inbox pages have no accessibility violations at 390 and 1280 px, light and dark", async () => {
      const page = getPage();
      const detailUrl = async () => {
        await page.goto(LIST);
        await page.getByRole("link", { name: "Alice Archer" }).click();
        await expect(
          page.getByRole("heading", { name: "Message from Alice Archer" }),
        ).toBeVisible();
      };
      for (const width of [390, 1280]) {
        for (const scheme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          const label = `${width}px ${scheme}`;

          await page.goto(LIST);
          await expect(page.getByTestId("message-row").first()).toBeVisible();
          await noHorizontalScroll(page, width);
          let found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `list ${label}`).toEqual([]);

          await detailUrl();
          await noHorizontalScroll(page, width);
          found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `detail ${label}`).toEqual([]);

          await page.getByRole("button", { name: "Delete for good" }).click();
          await expect(
            page.getByRole("group", { name: "Delete this message for good?" }),
          ).toBeVisible();
          found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `delete confirmation ${label}`).toEqual([]);
        }
      }
      await page.emulateMedia({ colorScheme: null });
    });
  });
}
