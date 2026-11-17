// WCAG contrast for the theme editor, the same sums as api/core/theme.py.
// The API has the final say; this only lets the editor warn as you type.

export type Tokens = { background: string; ink: string; accent: string; on_accent: string };
export type Theme = { light: Tokens; dark: Tokens };
export type Mode = keyof Theme;

export const MODES: Mode[] = ["light", "dark"];
export const TOKEN_NAMES: [keyof Tokens, string][] = [
  ["background", "Background"],
  ["ink", "Text"],
  ["accent", "Accent"],
  ["on_accent", "Text on accent"],
];

export const PAIRS: { front: keyof Tokens; back: keyof Tokens; minimum: number; use: string }[] = [
  { front: "ink", back: "background", minimum: 4.5, use: "Text on the background" },
  { front: "on_accent", back: "accent", minimum: 4.5, use: "Text on the accent colour" },
  { front: "accent", back: "background", minimum: 3, use: "The accent colour against the background" },
];

export const DEFAULT_THEME: Theme = {
  light: { background: "#f5efe3", ink: "#161412", accent: "#e2531b", on_accent: "#161412" },
  dark: { background: "#161412", ink: "#f5efe3", accent: "#f06a35", on_accent: "#161412" },
};

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

export type Failure = {
  mode: Mode;
  front: keyof Tokens;
  back: keyof Tokens;
  ratio: number;
  minimum: number;
  use: string;
};

/** Every pair below its minimum. Colours that are not #rrggbb are skipped here
 * and refused by the schema instead. */
export function failures(theme: Theme): Failure[] {
  const found: Failure[] = [];
  for (const mode of MODES) {
    const colours = theme[mode];
    for (const pair of PAIRS) {
      const front = colours[pair.front];
      const back = colours[pair.back];
      if (!HEX.test(front) || !HEX.test(back)) continue;
      const ratio = contrast(front, back);
      if (ratio < pair.minimum) found.push({ mode, ratio, ...pair });
    }
  }
  return found;
}
