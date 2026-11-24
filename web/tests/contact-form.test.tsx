import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactFormView, type FormState, INITIAL_STATE } from "@/components/public/ContactForm";
import { contrast } from "@/lib/admin/contrast";
import { validate } from "@/lib/public/contact";
import type { PublicSite } from "@/lib/site";

const ready: FormState = { ...INITIAL_STATE, ready: true };
const html = (state: FormState = INITIAL_STATE) => renderToString(<ContactFormView state={state} />);

describe("the form's markup", () => {
  it("has a labelled field for each thing asked, with required and optional said in words", () => {
    const markup = html();
    for (const [id, label] of [
      ["contact-name", "Name"],
      ["contact-email", "Email"],
      ["contact-reason", "Reason"],
      ["contact-body", "Message"],
    ]) {
      expect(markup).toMatch(new RegExp(`<label for="${id}">${label}`));
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup.match(/\(required\)/g)).toHaveLength(3);
    expect(markup).toContain("Reason<span> (optional)</span>");
    expect(markup).toContain('aria-required="true"');
  });

  it("uses the right kinds of field, with autocomplete and limits", () => {
    const markup = html();
    expect(markup).toContain('autoComplete="name"');
    expect(markup).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"/);
    expect(markup).toContain('maxLength="100"');
    expect(markup).toContain('maxLength="254"');
    expect(markup).toContain('maxLength="4000"');
    expect(markup).toContain("<textarea");
  });

  it("offers the three reasons, none chosen", () => {
    const markup = html();
    const options = [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "Choose a reason (optional)"],
      ["hiring", "Hiring"],
      ["project", "A project"],
      ["other", "Something else"],
    ]);
  });

  it("has a honeypot that is out of the way for people: hidden from readers, out of the tab order, no autofill", () => {
    const trap = /<div class="contact-form__trap" aria-hidden="true">([^]*?)<\/div>/.exec(html())?.[1] ?? "";
    expect(trap).toContain('id="contact-website"');
    expect(trap).toContain('tabindex="-1"');
    expect(trap).toContain('autoComplete="off"');
    expect(trap).toContain("Leave this field empty");
  });

  it("posts natively and names no field, so a submit before its code arrives sends no values", () => {
    const markup = html();
    expect(markup).toMatch(/<form id="contact-form"[^>]* method="post"/);
    expect(markup).not.toContain(" name=");
    for (const id of ["name", "email", "reason", "body", "website"]) {
      expect(markup).toContain(`id="contact-${id}"`);
    }
  });

  it("has an empty status region that is live, before and after something is said", () => {
    expect(html()).toMatch(/<p id="contact-status" role="status" aria-live="polite" class="contact-form__status"><\/p>/);
    expect(html({ ...ready, announcement: "Sending your message…" })).toContain(
      'class="contact-form__status">Sending your message…</p>',
    );
  });

  it("holds a place for every error, so a message appearing moves nothing", () => {
    const markup = html();
    for (const name of ["name", "email", "reason", "body"]) {
      expect(markup).toContain(`<p id="contact-${name}-error" class="contact-form__error"></p>`);
      expect(markup).toContain(`${name === "name" ? "" : ""}aria-describedby="`);
    }
    expect(readFileSync("app/(site)/site.css", "utf8")).toMatch(/\.contact-form__error \{[^}]*min-height: 3\.2em/);
  });

  it("starts with the button off, and turns it on once the form's code has taken over", () => {
    expect(html()).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Send message<\/button>/);
    expect(html(ready)).not.toMatch(/<button type="submit"[^>]*disabled/);
  });

  it("shows sending, with the button off again", () => {
    const markup = html({ ...ready, status: "sending", announcement: "Sending your message…" });
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Sending…<\/button>/);
  });

  it("says Error in words and marks the field, so colour is not the only sign", () => {
    const errors = validate({ name: "", email: "bad", reason: "", body: "" });
    const markup = html({ ...ready, errors });
    expect(markup.match(/aria-invalid="true"/g)).toHaveLength(3);
    expect(markup).toContain('<span class="contact-form__error-label">Error: </span>Enter your name.');
    expect(markup).toContain("Error: </span>Enter a valid email address.");
    expect(markup).toContain("Error: </span>Write a little more.");
    expect(markup).not.toMatch(/<select[^>]*aria-invalid/);
    expect(readFileSync("app/(site)/site.css", "utf8")).toMatch(
      /\.contact-form \[aria-invalid="true"\] \{[^}]*border-style: dashed/,
    );
  });

  it("ties each error to its field", () => {
    const markup = html({ ...ready, errors: { email: "Enter a valid email address." } });
    expect(markup).toMatch(/<input[^>]*aria-describedby="contact-email-hint contact-email-error"/);
  });

  it("shows a clear success state that can take focus, with a way to send another", () => {
    const markup = html({ ...ready, status: "sent", announcement: "Thank you. Your message has been received." });
    expect(markup).toContain('id="contact-sent"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("<h3>Message sent</h3>");
    expect(markup).toContain("Thank you. Your message has been received.");
    expect(markup).toContain("Send another message");
    expect(markup).not.toContain("<form");
    expect(markup).toContain('role="status"');
  });

  it("writes the same markup every time, which is what lets the client take it over", () => {
    expect(html()).toBe(html());
    expect(html(INITIAL_STATE)).toBe(renderToString(<ContactFormView />));
  });

  it("has no inline style, no script and no event handler attributes", () => {
    for (const markup of [html(), html({ ...ready, status: "sent" }), html({ ...ready, errors: { name: "x" } })]) {
      expect(markup).not.toMatch(/\sstyle=/);
      expect(markup).not.toContain("<script");
      expect(markup).not.toMatch(/\son[a-z]+=/i);
    }
  });

  it("links to the privacy notice and says Turnstile is used, and shows no email address", () => {
    const markup = html();
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain("Cloudflare Turnstile");
    expect(markup).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(markup).not.toContain("mailto:");
  });

  it("shows sender-controlled text only as text", () => {
    const markup = html({ ...ready, errors: { name: "<img src=x onerror=alert(1)>" } });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });
});

const published = (contact_form?: boolean): PublicSite => ({
  settings: contact_form === undefined ? {} : { contact_form },
  sections: [],
  palettes: [],
  media: {},
});

async function block(env: Record<string, string>, site: PublicSite) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { ContactBlock, contactAvailable } = await import("@/components/public/ContactBlock");
  return { markup: renderToString(<ContactBlock site={site} />), available: contactAvailable(site) };
}

const SET = { NEXT_PUBLIC_API_BASE_URL: "https://api.example.test", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000BB" };

describe("the contact block in the page", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("carries the marker the CSP is built from, the form, and a hidden failure note", async () => {
    const { markup, available } = await block(SET, published());
    expect(available).toBe(true);
    expect(markup).toContain("data-contact-form");
    expect(markup).toContain("data-contact-root");
    expect(markup).toContain('id="contact-form"');
    expect(markup).toMatch(/data-contact-failed[^>]*hidden/);
  });

  it("tells a visitor without JavaScript that the form needs it, and points to the links, with no address", async () => {
    const { markup } = await block(SET, published());
    const note = /<noscript>([^]*?)<\/noscript>/.exec(markup)?.[1] ?? "";
    expect(note).toContain("needs JavaScript");
    expect(note).toContain("professional links below");
    expect(note).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(note).not.toContain("mailto:");
  });

  it("hides the form from visitors without JavaScript, by a rule that waits for the boot script", () => {
    const css = readFileSync("app/(site)/site.css", "utf8");
    expect(css).toMatch(/\.contact__wrap \{\s*display: none;/);
    expect(css).toMatch(/html\[data-theme\] \.contact__wrap \{\s*display: block;/);
  });

  it.each([
    ["the owner turned the form off", SET, false],
    ["there is no API address", { ...SET, NEXT_PUBLIC_API_BASE_URL: "" }, true],
    ["there is no Turnstile site key", { ...SET, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "" }, true],
  ])("shows no form, only a note, when %s", async (_name, env, setting) => {
    const { markup, available } = await block(env, published(setting));
    expect(available).toBe(false);
    expect(markup).not.toContain("data-contact-form");
    expect(markup).not.toContain("<form");
    expect(markup).toContain("The contact form is not available at the moment.");
    expect(markup).toContain("professional links below");
  });
});

describe("the form's colours", () => {
  const css = readFileSync("app/(site)/site.css", "utf8");
  const start = css.indexOf("/* The contact form.");
  const form = css.slice(start, css.indexOf("/* Gallery */"));

  it("come only from the palette's ink and background, never a raw colour", () => {
    expect(form.length).toBeGreaterThan(500);
    expect(form).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(form).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|color-mix)\(/);
    const used = [...form.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]);
    const colours = new Set(used.filter((name) => name.startsWith("--c-") || ["--fg", "--ground"].includes(name)));
    expect([...colours].sort()).toEqual(["--c-bg", "--c-ink", "--fg", "--ground"]);
  });

  it("sit inside a card that sets the text colour to ink and the ground to the page colour", () => {
    expect(form).toMatch(/\.contact-form,\s*\.contact-sent \{[^}]*--fg: var\(--c-ink\);[^}]*--ground: var\(--c-bg\);/);
  });

  it("never fade with opacity, which would lower a contrast that was checked", () => {
    expect(form).not.toContain("opacity");
  });

  it("use the one pair every palette must pass: the same sum the API runs", () => {
    // Every saved palette passes ink on bg at 4.5:1 in light and dark; these
    // are the preset pairs, which the API checks the same way.
    const presets: Record<string, { light: [string, string]; dark: [string, string] }> = {
      original: { light: ["#17140F", "#F3EBDD"], dark: ["#F3EBDD", "#17140F"] },
    };
    for (const pair of Object.values(presets)) {
      for (const [ink, bg] of Object.values(pair)) expect(contrast(ink, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
