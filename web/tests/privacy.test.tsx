import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyPage } from "@/components/public/FooterPages";
import { privacyEmailFrom } from "@/lib/public/privacy-email";

const ADDRESS = "requests@example.org";

const page = (email = "") => renderToStaticMarkup(<PrivacyPage name="Pat Example" email={email} />);

/** The page as one run of text. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("the data-request address", () => {
  it("is empty when unset", () => {
    expect(privacyEmailFrom({})).toBe("");
    expect(privacyEmailFrom({ NEXT_PUBLIC_PRIVACY_EMAIL: "" })).toBe("");
    expect(privacyEmailFrom({ NEXT_PUBLIC_PRIVACY_EMAIL: "   " })).toBe("");
  });

  it("fails a Cloudflare Pages build that has none", () => {
    for (const unset of [undefined, "", "   "]) {
      expect(() => privacyEmailFrom({ CF_PAGES: "1", NEXT_PUBLIC_PRIVACY_EMAIL: unset })).toThrow(
        "NEXT_PUBLIC_PRIVACY_EMAIL is not set",
      );
    }
    expect(privacyEmailFrom({ CF_PAGES: "1", NEXT_PUBLIC_PRIVACY_EMAIL: ADDRESS })).toBe(ADDRESS);
  });

  it("is the address when set, trimmed", () => {
    expect(privacyEmailFrom({ NEXT_PUBLIC_PRIVACY_EMAIL: ` ${ADDRESS} ` })).toBe(ADDRESS);
  });

  it.each([
    "not-an-address",
    "two@@example.org",
    "a b@example.org",
    "name@localhost",
    "<script>@example.org",
    "mailto:requests@example.org",
    "requests@example.org, other@example.org",
    `${"a".repeat(65)}@example.org`,
  ])("refuses %j, so the build fails", (bad) => {
    expect(() => privacyEmailFrom({ NEXT_PUBLIC_PRIVACY_EMAIL: bad })).toThrow(
      "NEXT_PUBLIC_PRIVACY_EMAIL is not a plain email address.",
    );
  });
});

describe("the Privacy page", () => {
  it("says the data-request address will be added before launch while it is unset", () => {
    const html = page();
    expect(text(html)).toContain("the data-request email address, which will be added before the site launches");
    expect(html).not.toContain("mailto:");
    expect(html).not.toMatch(/[\w.]+@[\w.]+/);
  });

  it("shows the address, and only that address, once it is set", () => {
    const html = page(ADDRESS);
    expect(html).toContain(`href="mailto:${ADDRESS}"`);
    expect([...html.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0])).toEqual([ADDRESS, ADDRESS]);
    expect(text(html)).not.toContain("will be added before the site launches");
  });

  it("no longer says that no email address is shown", () => {
    expect(text(page())).not.toContain("No email address is shown on this site");
    expect(text(page())).toContain("The only email address shown on this site is the data-request address");
  });

  it("states the retention periods and what keeps a message longer", () => {
    const t = text(page());
    expect(t).toContain("12 months by default");
    expect(t).toContain("held back by the checks");
    expect(t).toContain("kept for 30 days");
    expect(t).toContain("can change both periods");
    expect(t).toContain("if it has notes on it");
    expect(t).toContain("marked it to keep");
    expect(t).toContain("linked to a saved contact");
  });

  it("gives the limits as current defaults", () => {
    const t = text(page());
    expect(t).toContain("that Pat Example can change");
    expect(t).toContain("The current defaults are 5 messages an hour from each address, 3 a day from each email address");
    expect(t).toContain("25 real messages and 20 held-back messages a day");
  });

  it("describes saved contacts as private and kept until deleted", () => {
    const t = text(page());
    expect(t).toContain("organisation, tags, notes and a follow-up date");
    expect(t).toContain("Contacts are private");
    expect(t).toContain("kept until Pat Example deletes it");
  });

  it("describes the blocklist: hash by default, the address only by choice, 12 months, told received", () => {
    const t = text(page());
    expect(t).toContain("keeps only a scrambled hash of the email address");
    expect(t).toContain("can choose to keep the address itself");
    expect(t).toContain("removed automatically after 12 months by default, unless Pat Example renews it");
    expect(t).toContain("A blocked sender is told the message was received");
    expect(t).toContain("counts how many messages it stopped");
    expect(t).toContain("holds no personal data");
  });

  it("says how to ask, how the request is checked and when to expect a reply", () => {
    const t = text(page(ADDRESS));
    expect(t).toContain(`email ${ADDRESS}`);
    expect(t).toContain("comes from the email address your messages came from, or ask for other proof");
    expect(t).toContain("reply within one month");
  });

  it("says what delete-everything removes and the block exception", () => {
    const t = text(page());
    expect(t).toContain("all the messages from your email address, the notes written on them, and your saved contact");
    expect(t).toContain("including messages marked to keep");
    expect(t).toContain("unless Pat Example chooses to keep you blocked");
    expect(t).toContain("only a scrambled hash of the address stays");
  });

  it("names the log exception and what it keeps", () => {
    const t = text(page());
    expect(t).toContain("security and audit logs");
    expect(t).toContain("It cannot be edited");
    expect(t).toContain("holds no message text");
    expect(t).toContain("a scrambled code of the email address and counts");
  });

  it("no longer sends requests through the contact form", () => {
    expect(text(page())).not.toContain("send a message through the contact form");
  });
});
