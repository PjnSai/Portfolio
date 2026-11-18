// WCAG contrast for palettes, the same sums as api/core/theme.py, checked
// against the same vectors (api/tests/contrast_vectors.json).
// The API has the final say; this only lets the editor warn as you type.

import { MODES, type PaletteColours, type PaletteMode, type Slot, type Slots } from "@/lib/palettes";

export type Pair = { front: Slot; back: Slot; minimum: number };

const ACCENTS = [1, 2, 3, 4] as const;

// All text at 4.5:1. The primary is a decorative fill with no rule against the
// page, so no control may rely on a primary fill alone.
export const PAIRS: Pair[] = [
  { front: "ink", back: "bg", minimum: 4.5 },
  { front: "ink", back: "surface", minimum: 4.5 },
  { front: "on_primary", back: "primary", minimum: 4.5 },
  ...ACCENTS.map((n) => ({ front: `on_accent_${n}` as Slot, back: `accent_${n}` as Slot, minimum: 4.5 })),
];

export const HEX = /^#[0-9a-fA-F]{6}$/;

function channel(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(colour.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(one: string, two: string): number {
  const [lighter, darker] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The ratio as the API rounds it in its messages. */
export const shown = (ratio: number) => ratio.toFixed(2);

export type Check = Pair & { mode: PaletteMode; ratio: number; passes: boolean; message: string };

/** Every pair in one mode with its ratio. Colours that are not #RRGGBB are
 * skipped here and refused by the schema instead. */
export function checks(mode: PaletteMode, colours: Slots): Check[] {
  const found: Check[] = [];
  for (const pair of PAIRS) {
    const front = colours[pair.front];
    const back = colours[pair.back];
    if (!HEX.test(front ?? "") || !HEX.test(back ?? "")) continue;
    const ratio = contrast(front, back);
    const name = mode === "light" ? "Light" : "Dark";
    const message = `${name}: ${pair.front} on ${pair.back} is ${shown(ratio)}:1; it needs at least ${pair.minimum}:1.`;
    found.push({ ...pair, mode, ratio, passes: ratio >= pair.minimum, message });
  }
  return found;
}

export type Failure = Check;

/** Every pair below its minimum, worded as the API words it. */
export function failures(palette: PaletteColours): Failure[] {
  return MODES.flatMap((mode) => checks(mode, palette[mode]).filter((check) => !check.passes));
}
