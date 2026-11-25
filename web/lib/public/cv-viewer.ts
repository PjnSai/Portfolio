// The viewer's rules, apart from its markup and from pdf.js itself, so they can
// be tested without a browser.

import { type Failure, viewFailureText } from "@/lib/public/cv";

export type ViewerPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; failure: Failure | { kind: "expired" } };

/**
 * What pdf.js is told. Nothing here needs eval, a script, a font made from
 * data or WebAssembly, so the page's policy (no 'unsafe-eval', no data fonts)
 * needs no loosening: glyphs are drawn from their outlines, and a PDF that
 * needs a codec only WebAssembly provides shows without that image.
 */
export const PDF_OPTIONS = {
  isEvalSupported: false,
  enableScripting: false,
  enableXfa: false,
  disableFontFace: true,
  useSystemFonts: true,
  useWasm: false,
  verbosity: 0,
} as const;

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

/** How much to scale a page so it fills the width it has, within limits. */
export function fitScale(boxWidth: number, pageWidth: number): number {
  if (!(boxWidth > 0) || !(pageWidth > 0)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, boxWidth / pageWidth));
}

export function pageLabel(page: number, total: number): string {
  return `CV, page ${page} of ${total}, shown as an image`;
}

/**
 * Where Tab should go to stay inside the dialog: the first item after the last,
 * the last before the first, and nowhere special (null: let the browser move)
 * from anywhere else.
 */
export function trapTarget<T>(items: readonly T[], active: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (active === null || !items.includes(active)) return backwards ? last : first;
  if (backwards && active === first) return last;
  if (!backwards && active === last) return first;
  return null;
}

export function viewerStatus(phase: ViewerPhase, pages: number): string {
  switch (phase.kind) {
    case "loading":
      return "Loading the CV…";
    case "ready":
      return `The CV is shown. It has ${pages} ${pages === 1 ? "page" : "pages"}.`;
    default:
      return viewFailureText(phase.failure);
  }
}
