import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CV_IDS,
  INSTANT_HINT,
  CvRequestView,
  INITIAL_REQUEST,
  type RequestState,
} from "@/components/public/CvRequestForm";
import { SENT_TEXT } from "@/lib/public/contact";
import { LINK_NOTE } from "@/lib/public/cv";

const ready: RequestState = { ...INITIAL_REQUEST, ready: true };
const html = (state: RequestState = INITIAL_REQUEST) => renderToString(<CvRequestView state={state} />);
const LINK = "http://localhost:8100/api/v1/cv/file/abc:def:ghi";

describe("the request form's markup", () => {
  it("has labelled fields with their need said in words, and none called Name, Email or Message", () => {
    const markup = html();
    expect(markup).toMatch(/<label for="cv-request-name">Your name<span> \(optional\)<\/span>/);
    expect(markup).toMatch(/<label for="cv-request-email">Your email<span class="contact-form__required"> \(required\)<\/span>/);
    expect(markup).toMatch(/<label for="cv-request-note">Note<span> \(optional\)<\/span>/);
    // These labels must not match the contact form's own, which sits on the same page.
    const labels = [...markup.matchAll(/<label for="[^"]+">([^<]*)/g)].map((m) => m[1]);
    for (const label of labels) expect(label).not.toMatch(/^(Name|Email|Message|Reason)/);
  });

  it("uses the right kinds of field with the API's limits", () => {
    const markup = html();
    expect(markup).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"/);
    expect(markup).toContain('autoComplete="name"');
    expect(markup).toContain('maxLength="500"');
    expect(markup).toContain('maxLength="254"');
    expect(markup).toContain("<textarea");
  });

  it("has the honeypot, hidden from readers and out of the tab order", () => {
    const trap = /<div class="contact-form__trap" aria-hidden="true">([^]*?)<\/div>/.exec(html())?.[1] ?? "";
    expect(trap).toContain('id="cv-request-website"');
    expect(trap).toContain('tabindex="-1"');
    expect(trap).toContain('autoComplete="off"');
  });

  it("posts natively and names no field, so an early submit sends nothing", () => {
    const markup = html();
    expect(markup).toMatch(/<form id="cv-request-form"[^>]* method="post"/);
    expect(markup).not.toMatch(/<(input|textarea)[^>]* name=/);
  });

  it("has a live region for progress and problems", () => {
    const markup = html({ ...ready, announcement: "Sending your request…" });
    expect(markup).toMatch(/<p id="cv-request-status" role="status" aria-live="polite"[^>]*>Sending your request…/);
  });

  it("has the button off until the code has taken over, and while sending", () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>Request a copy/);
    expect(html(ready)).not.toMatch(/disabled/);
    expect(html({ ...ready, status: "sending" })).toMatch(/<button[^>]*disabled=""[^>]*>Sending…/);
  });

  it("tells the visitor about the download link only when the API says one follows", () => {
    expect(renderToString(<CvRequestView state={ready} instant />)).toContain(INSTANT_HINT);
    expect(html(ready)).not.toContain(INSTANT_HINT);
    expect(html(ready)).not.toMatch(/download/i);
  });

  it("is the target the viewer's text alternative links to", () => {
    expect(CV_IDS.wrapper).toBe("cv-request");
    expect(renderToString(<CvRequestView state={ready} />)).toContain('id="cv-request-form"');
  });

  it("says what is kept and links the privacy notice", () => {
    const markup = html();
    expect(markup).toContain("Turnstile");
    expect(markup).toContain('href="/privacy"');
  });

  it("shows errors by their fields", () => {
    const markup = html({ ...ready, errors: { email: "Enter a valid email address." } });
    expect(markup).toMatch(/id="cv-request-email"[^>]*aria-invalid="true"/);
    expect(markup).toContain("Enter a valid email address.");
  });
});

describe("the received view", () => {
  const sent = (download: string | null, expired = false): RequestState => ({
    ...ready,
    status: "sent",
    announcement: SENT_TEXT,
    download,
    expired,
  });

  it("says the contact form's received message", () => {
    const markup = html(sent(null));
    expect(markup).toContain(SENT_TEXT);
    expect(markup).toContain('id="cv-request-sent"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("has no download button and no link without a link in the answer", () => {
    const markup = html(sent(null));
    expect(markup).not.toMatch(/download/i);
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain(LINK_NOTE);
  });

  it("has a clear Download the CV button, with the note about a minute, when a link came", () => {
    const markup = html(sent(LINK));
    expect(markup).toMatch(new RegExp(`<a[^>]*href="${LINK}"[^>]*>Download the CV</a>`));
    expect(markup).toContain(LINK_NOTE);
    expect(markup).toContain(SENT_TEXT);
  });

  it("looks the same, apart from the link, whatever the API did with the request", () => {
    // The state has nothing in it that says stored, spam or blocked.
    const strip = (markup: string) => markup.replace(/<a[^>]*>Download the CV<\/a>/, "").replace(`<p>${LINK_NOTE}</p>`, "");
    expect(strip(html(sent(LINK)))).toBe(strip(html(sent(null))));
  });

  it("takes the link away once its minute is up, and says so", () => {
    const markup = html(sent(LINK, true));
    expect(markup).not.toContain(LINK);
    expect(markup).not.toContain("Download the CV");
    expect(markup).toContain("The download link has expired.");
  });

  it("puts the result in a live region for readers", () => {
    expect(html(sent(null))).toMatch(/role="status"[^>]*aria-live="polite"[^>]*class="visually-hidden"|class="visually-hidden"[^>]*role="status"/);
  });
});
