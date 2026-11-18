"use client";

import type { Slots } from "@/lib/palettes";
import { slotVars, usePaint } from "./paint";

// Class names are written out in full so Tailwind finds them.
const STRIP = [
  "bg-[var(--p-bg)]",
  "bg-[var(--p-ink)]",
  "bg-[var(--p-surface)]",
  "bg-[var(--p-primary)]",
  "bg-[var(--p-accent-1)]",
  "bg-[var(--p-accent-2)]",
  "bg-[var(--p-accent-3)]",
  "bg-[var(--p-accent-4)]",
];

/** A row of colour blocks. Decorative: the palette name says what it is. */
export function SwatchStrip({ colours, label }: { colours: Slots; label: string }) {
  const paint = usePaint<HTMLDivElement>(slotVars(colours));
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 font-mono text-xs uppercase tracking-wide text-muted">{label}</span>
      <div ref={paint} aria-hidden="true" className="flex h-6 overflow-hidden rounded-md border border-ink">
        {STRIP.map((colour) => (
          <span key={colour} className={`block h-full w-6 ${colour}`} />
        ))}
      </div>
    </div>
  );
}
