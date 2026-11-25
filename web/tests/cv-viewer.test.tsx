import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CvDialogView, DIALOG_IDS } from "@/components/public/CvDialog";
import {
  fitScale,
  PDF_OPTIONS,
  pageLabel,
  trapTarget,
  viewerStatus,
} from "@/lib/public/cv-viewer";
import { IMAGE_ALTERNATIVE } from "@/lib/public/cv";

const noop = () => undefined;
const html = (props: Partial<Parameters<typeof CvDialogView>[0]> = {}) =>
  renderToString(
    <CvDialogView
      phase={{ kind: "loading" }}
      canRequest
      pageCount={0}
      onClose={noop}
      onRetry={noop}
      onRequest={noop}
      {...props}
    />,
  );

describe("the viewer's markup", () => {
  it("is one labelled dialog with a title and a Close button", () => {
    const markup = html();
    expect(markup).toContain("<dialog");
    expect(markup).toContain(`aria-labelledby="${DIALOG_IDS.title}"`);
    expect(markup).toMatch(new RegExp(`<h2 id="${DIALOG_IDS.title}"[^>]*>CV</h2>`));
    expect(markup).toMatch(/<button[^>]*>Close<\/button>/);
  });

  it("has no download control and no frame", () => {
    for (const phase of [
      { kind: "loading" },
      { kind: "ready" },
      { kind: "error", failure: { kind: "expired" } },
    ] as const) {
      const markup = html({ phase, pageCount: 2 });
      expect(markup).not.toMatch(/<a[^>]*\sdownload/i);
      expect(markup).not.toMatch(/download/i);
      expect(markup).not.toMatch(/<(iframe|object|embed)/i);
      expect(markup).not.toMatch(/href="[^"#]/);
    }
  });

  it("says the pages are images and links to the request form", () => {
    const markup = html({ phase: { kind: "ready" }, pageCount: 2 }).replaceAll("<!-- -->", "");
    expect(markup).toContain(IMAGE_ALTERNATIVE.split("request one")[0]);
    expect(markup).toMatch(/<a[^>]*href="#cv-request"[^>]*>request one<\/a>/);
  });

  it("offers no link to a form that is switched off", () => {
    const markup = html({ phase: { kind: "ready" }, pageCount: 1, canRequest: false });
    expect(markup).not.toContain("cv-request");
    expect(markup).not.toContain("For an accessible copy");
  });

  it("gives each page canvas an image role and a text alternative", () => {
    const markup = html({ phase: { kind: "ready" }, pageCount: 2 });
    const canvases = [...markup.matchAll(/<canvas[^>]*>/g)].map((m) => m[0]);
    expect(canvases).toHaveLength(2);
    expect(canvases[0]).toContain('role="img"');
    expect(canvases[0]).toContain('aria-label="CV, page 1 of 2, shown as an image"');
    expect(canvases[1]).toContain("page 2 of 2");
  });

  it("announces loading politely", () => {
    const markup = html();
    expect(markup).toMatch(/<p[^>]*role="status"[^>]*aria-live="polite"[^>]*>Loading the CV…<\/p>/);
  });

  it("shows an error as an alert with a retry button", () => {
    const markup = html({ phase: { kind: "error", failure: { kind: "expired" } } });
    expect(markup).toMatch(/role="alert"[^>]*>The link has expired/);
    expect(markup).toMatch(/<button[^>]*>Try again<\/button>/);
  });

  it("keeps the page canvases out of the tab order and makes the pages scrollable by keyboard", () => {
    const markup = html({ phase: { kind: "ready" }, pageCount: 1 });
    expect(markup).toMatch(/<div[^>]*class="cv-viewer__scroll"[^>]*tabindex="0"/);
    expect(markup).not.toMatch(/<canvas[^>]*tabindex/);
  });
});

describe("the viewer's rules", () => {
  it("never needs eval, scripting, fonts from data or wasm", () => {
    expect(PDF_OPTIONS.isEvalSupported).toBe(false);
    expect(PDF_OPTIONS.enableScripting).toBe(false);
    expect(PDF_OPTIONS.disableFontFace).toBe(true);
    expect(PDF_OPTIONS.useWasm).toBe(false);
    expect(PDF_OPTIONS.enableXfa).toBe(false);
  });

  it("fits a page to its box, never smaller than a quarter or beyond three times", () => {
    expect(fitScale(600, 300)).toBe(2);
    expect(fitScale(280, 612)).toBeCloseTo(280 / 612);
    expect(fitScale(10, 612)).toBe(0.25);
    expect(fitScale(5000, 100)).toBe(3);
    expect(fitScale(0, 612)).toBe(1);
  });

  it("labels each page for a screen reader", () => {
    expect(pageLabel(1, 3)).toBe("CV, page 1 of 3, shown as an image");
  });

  it("keeps Tab inside the dialog", () => {
    const items = ["a", "b", "c"];
    expect(trapTarget(items, "c", false)).toBe("a");
    expect(trapTarget(items, "a", true)).toBe("c");
    expect(trapTarget(items, "b", false)).toBeNull();
    expect(trapTarget(items, "b", true)).toBeNull();
    expect(trapTarget(items, null, false)).toBe("a");
    expect(trapTarget(items, "x", true)).toBe("c");
    expect(trapTarget([], null, false)).toBeNull();
    expect(trapTarget(["only"], "only", false)).toBe("only");
  });

  it("says each phase in words", () => {
    expect(viewerStatus({ kind: "loading" }, 0)).toBe("Loading the CV…");
    expect(viewerStatus({ kind: "ready" }, 2)).toBe("The CV is shown. It has 2 pages.");
    expect(viewerStatus({ kind: "ready" }, 1)).toBe("The CV is shown. It has 1 page.");
    expect(viewerStatus({ kind: "error", failure: { kind: "expired" } }, 0)).toMatch(/expired/);
  });
});

describe("how pdf.js is brought in", () => {
  const source = readFileSync("lib/public/cv-viewer.ts", "utf8") + readFileSync("lib/public/pdf.ts", "utf8");

  it("is imported only inside a function, never at the top of a file", () => {
    expect(source).not.toMatch(/^import[^\n]*pdfjs-dist/m);
    expect(source).toMatch(/await import\("pdfjs-dist/);
  });

  it("takes its worker from this site's own files", () => {
    expect(source).toMatch(/new URL\("pdfjs-dist\/build\/pdf\.worker\.min\.mjs", import\.meta\.url\)/);
    expect(source).not.toMatch(/https?:\/\//);
  });
});
