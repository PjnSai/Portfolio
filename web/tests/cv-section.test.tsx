import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CvBlock, cvBlockAvailable } from "@/components/public/CvBlock";
import { CvSectionView } from "@/components/public/CvSection";
import type { CvStatus } from "@/lib/public/cv";

const OFF: CvStatus = { canView: false, canRequest: false, instantDownload: false, updated: null };
const html = (status: CvStatus | null, props = {}) => renderToString(<CvSectionView status={status} {...props} />);

describe("the CV block with its switches", () => {
  it("shows nothing when there is no status, or both switches are off", () => {
    expect(html(null)).toBe("");
    expect(html(OFF)).toBe("");
    expect(html({ ...OFF, instantDownload: true })).toBe("");
  });

  it("shows only the view button when only viewing is on", () => {
    const markup = html({ ...OFF, canView: true });
    expect(markup).toContain("View the CV");
    expect(markup).not.toMatch(/not available/i);
  });

  it("shows no view button when only requests are on", () => {
    const markup = html({ ...OFF, canRequest: true }, { request: <form id="cv-form" /> });
    expect(markup).not.toContain("View the CV");
    expect(markup).toContain('id="cv-form"');
  });

  it("has a heading, the date and a live region", () => {
    const markup = html({ ...OFF, canView: true, updated: "2026-11-20" });
    expect(markup).toMatch(/<h3[^>]*>CV<\/h3>/);
    expect(markup).toContain("Updated 20 November 2026.");
    expect(markup).toMatch(/<p id="cv-status" role="status" aria-live="polite"/);
  });

  it("turns the button off until the code has taken over, and while busy", () => {
    const status = { ...OFF, canView: true };
    expect(html(status, { ready: false })).toMatch(/<button[^>]*disabled=""[^>]*>View the CV/);
    expect(html(status, { busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>View the CV/);
    expect(html(status, { ready: true })).not.toMatch(/disabled/);
  });
});

describe("the block in the page", () => {
  it("is empty markup for a loader to fill, with no CV words in it", () => {
    const markup = renderToString(<CvBlock available />);
    expect(markup).toContain("data-cv-block");
    expect(markup).toContain("data-cv-root");
    expect(markup.replace(/<[^>]*>/g, "")).toBe("");
  });

  it("is not in the page at all when the build has no API or no Turnstile key", () => {
    expect(renderToString(<CvBlock available={false} />)).toBe("");
    expect(cvBlockAvailable("http://localhost:8100", "key-key-key-key-key")).toBe(true);
    expect(cvBlockAvailable("", "key-key-key-key-key")).toBe(false);
    expect(cvBlockAvailable("http://localhost:8100", "")).toBe(false);
  });
});
