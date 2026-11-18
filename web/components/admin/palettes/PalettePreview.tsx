"use client";

import type { PaletteMode, Slots } from "@/lib/palettes";
import { slotVars, usePaint } from "./paint";

const TILES = [
  ["bg-[var(--p-accent-1)] text-[var(--p-on-accent-1)]", "01", "Projects"],
  ["bg-[var(--p-accent-2)] text-[var(--p-on-accent-2)]", "02", "Roles"],
  ["bg-[var(--p-accent-3)] text-[var(--p-on-accent-3)]", "03", "Skills"],
  ["bg-[var(--p-accent-4)] text-[var(--p-on-accent-4)]", "04", "Awards"],
] as const;

// Every control drawn on a primary fill also has an ink border, because the
// primary has no contrast rule against the page.
const PRIMARY_BUTTON =
  "inline-block rounded-md border-2 border-[var(--p-ink)] bg-[var(--p-primary)] px-3 py-1.5 text-xs font-bold text-[var(--p-on-primary)]";
const PLAIN_BUTTON =
  "inline-block rounded-md border-2 border-[var(--p-ink)] bg-[var(--p-surface)] px-3 py-1.5 text-xs font-bold text-[var(--p-ink)]";

/**
 * A small copy of the home page in one mode, coloured only through the slot
 * variables. Placeholder words only; nothing here is real content.
 */
export function PalettePreview({ mode, colours }: { mode: PaletteMode; colours: Slots }) {
  const paint = usePaint<HTMLDivElement>(slotVars(colours));
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
        {mode === "light" ? "Light" : "Dark"}
      </figcaption>
      <div
        ref={paint}
        data-testid={`preview-${mode}`}
        className="overflow-hidden rounded-lg border-2 border-ink bg-[var(--p-bg)] text-[var(--p-ink)]"
      >
        <div className="flex items-center justify-between gap-2 border-b-2 border-[var(--p-ink)] px-3 py-2">
          <span className="font-display text-sm font-extrabold">Your name</span>
          <span className="hidden gap-3 text-xs sm:flex">
            <span>Work</span>
            <span>About</span>
          </span>
          <span className={PRIMARY_BUTTON}>Get in touch</span>
        </div>
        <div className="space-y-3 px-3 py-4">
          <span className="inline-block rounded-md border-2 border-[var(--p-ink)] bg-[var(--p-primary)] px-2 py-0.5 font-mono text-xs uppercase text-[var(--p-on-primary)]">
            Hero tag
          </span>
          <p className="font-display text-xl font-extrabold leading-tight">A short heading line</p>
          <div className="flex flex-wrap gap-2">
            <span className={PRIMARY_BUTTON}>Main button</span>
            <span className={PLAIN_BUTTON}>Second button</span>
          </div>
          <div className="rounded-md border-2 border-[var(--p-ink)] bg-[var(--p-surface)] p-3">
            <p className="text-sm font-bold">Project card</p>
            <p className="text-xs">Card text sits on the surface colour.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {TILES.map(([colour, number, word]) => (
              <div key={number} className={`rounded-md p-2 ${colour}`}>
                <p className="font-display text-lg font-extrabold">{number}</p>
                <p className="font-mono text-xs uppercase">{word}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-[var(--p-primary)] px-3 py-4 text-[var(--p-on-primary)]">
          <p className="font-display text-lg font-extrabold">Contact band</p>
          <span className="mt-2 inline-block rounded-md border-2 border-[var(--p-ink)] bg-[var(--p-bg)] px-3 py-1.5 text-xs font-bold text-[var(--p-ink)]">
            Send a message
          </span>
        </div>
      </div>
    </figure>
  );
}
