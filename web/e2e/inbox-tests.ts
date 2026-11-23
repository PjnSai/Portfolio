import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { challenge, sendMessage } from "./fixtures/contact";

// The inbox steps of the admin suite. They run inside admin.spec.ts, after the
// owner has signed in, because that spec holds the one passkey and its session.
// Messages are sent through the real public route, so this also covers a
// message arriving from the site and showing up for the owner.

const PEOPLE = [
  {
    name: "Alice Archer",
    body: "Hello, I would like to discuss a graduate role with you.",
  },
  {
    name: "Bruno Baker",
    body: "Hi, we have a short project that might suit your skills.",
  },
  {
    name: "Chen Cole",
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

async function folderCount(page: Page, folder: string) {
  const link = page
    .getByRole("navigation", { name: "Message folders" })
    .getByRole("link", { name: new RegExp(`^${folder}`) });
  await expect(link).toHaveText(/\d/);
  return Number((await link.innerText()).replace(/\D/g, ""));
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
      const started = (await challenge(request, "203.0.113.200")).started;
      // The form must have been open for three seconds, or it counts as a bot.
      await new Promise((done) => setTimeout(done, 3200));

      const answers = [];
      for (const person of PEOPLE) {
        answers.push(
          await sendMessage(request, started, {
            ...person,
            body: `${person.body} (${run})`,
            email: email(person.name),
          }),
        );
      }
      for (const person of SPAMMERS) {
        answers.push(
          await sendMessage(request, started, {
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
      await page.goto("/desk/messages");

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
      await page.goto("/desk/messages");
      await page.getByRole("link", { name: "Alice Archer" }).click();

      const heading = page.getByRole("heading", {
        name: "Message from Alice Archer",
      });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.getByText(PEOPLE[0].body)).toBeVisible();
      await expect(page.getByText("Email (not verified)")).toBeVisible();
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
      await page.goto("/desk/messages");
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
      await page.goto("/desk/messages");
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
      await page.goto("/desk/messages");
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

    test("delete asks first, can be cancelled from the keyboard, then removes the message", async () => {
      const page = getPage();
      await page.goto("/desk/messages");
      await page.getByRole("link", { name: "Bruno Baker" }).click();
      await expect(
        page.getByRole("heading", { name: "Message from Bruno Baker" }),
      ).toBeFocused();

      const ask = page.getByRole("button", { name: "Delete", exact: true });
      await ask.focus();
      await page.keyboard.press("Enter");
      const group = page.getByRole("group", {
        name: "Delete this message for good?",
      });
      await expect(group).toBeVisible();
      await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(group).toHaveCount(0);
      await expect(ask).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        page.getByRole("button", { name: "Delete for good" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(/\/desk\/messages(\?|$)/);
      await expect(
        page.getByRole("status").filter({ hasText: "Message deleted." }),
      ).toBeVisible();
      await expect(page.getByText("Bruno Baker")).toHaveCount(0);
      await expect(page.getByTestId("message-row")).toHaveCount(2);
      expect(await folderCount(page, "Inbox")).toBe(2);
      // The notice is taken out of the address, so a reload does not repeat it.
      await expect(page).not.toHaveURL(/notice=/);
    });

    test("the spam tab lists held-back messages, and Not spam moves one to the inbox", async () => {
      const page = getPage();
      await page.goto("/desk/messages");
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
      await page.goto("/desk/messages");
      expect(await folderCount(page, "Inbox")).toBe(3);
      expect(await folderCount(page, "Spam")).toBe(1);
    });

    test("the inbox pages have no accessibility violations at 390 and 1280 px, light and dark", async () => {
      const page = getPage();
      const detailUrl = async () => {
        await page.goto("/desk/messages");
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

          await page.goto("/desk/messages");
          await expect(page.getByTestId("message-row").first()).toBeVisible();
          await noHorizontalScroll(page, width);
          let found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `list ${label}`).toEqual([]);

          await detailUrl();
          await noHorizontalScroll(page, width);
          found = await new AxeBuilder({ page }).analyze();
          expect(found.violations, `detail ${label}`).toEqual([]);

          await page
            .getByRole("button", { name: "Delete", exact: true })
            .click();
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
