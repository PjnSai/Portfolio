import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessibilityPage, PrivacyPage, SecurityPage } from "@/components/public/FooterPages";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("what the footer pages say about the CV", () => {
  const privacy = text(renderToStaticMarkup(<PrivacyPage name="Pat Example" email="" />));

  it("no longer says it is not available yet", () => {
    expect(privacy).not.toMatch(/not available yet/i);
    expect(privacy).not.toContain("CV download");
  });

  it("says what is kept, for how long and why a download link is given to everyone", () => {
    for (const words of [
      "The CV",
      "one minute",
      "no download button",
      "90 days",
      "No IP address and no email address",
      "marked as a CV request",
      "sends no email",
      "whether or not the request was kept",
      "casual saving",
    ]) {
      expect(privacy).toContain(words);
    }
  });

  it("says each part can be switched off, with nothing then shown", () => {
    expect(privacy).toContain("switched off");
    expect(privacy).toContain("says nothing about a CV");
  });

  it("says the pop-up needs JavaScript and the pages are images with an accessible copy by request", () => {
    const page = text(renderToStaticMarkup(<AccessibilityPage />));
    expect(page).toContain("CV pop-up need");
    expect(page).toContain("page images");
    expect(page).toContain("accessible copy");
  });

  it("says the CV has no lasting address", () => {
    expect(text(renderToStaticMarkup(<SecurityPage />))).toContain("The CV has no lasting address");
  });
});
