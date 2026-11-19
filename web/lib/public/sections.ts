// Where the pager's Next section button goes. Pure, so it has unit tests;
// NavEnhancer supplies the page's state.

export type NextStep = { kind: "section"; index: number } | { kind: "top" } | null;

/**
 * The section the visitor is on: a section they just jumped to (while the
 * scroll is still moving), the last one at the very bottom of the page, else
 * the one marked in view. -1 means above the first section.
 */
export function currentSection(count: number, marked: number, atBottom: boolean, jumped: number | null): number {
  if (count <= 0) return -1;
  if (jumped !== null) return Math.min(Math.max(jumped, -1), count - 1);
  if (atBottom) return count - 1;
  return Math.min(Math.max(marked, -1), count - 1);
}

/** The section after `current`, or back to the top from the last one. */
export function nextStep(count: number, current: number): NextStep {
  if (count <= 0) return null;
  if (current >= count - 1) return { kind: "top" };
  return { kind: "section", index: Math.max(current, -1) + 1 };
}
