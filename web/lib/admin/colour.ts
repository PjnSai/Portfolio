// Colour fields in the palette editor: hex text and R/G/B numbers kept in step.

export type Rgb = [number, number, number];

/** "#RRGGBB" in upper case, from "#rrggbb" or "rrggbb"; null for anything else. */
export function parseHex(text: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

export function toRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** One channel from a number field: whole numbers 0 to 255, or null. */
export function parseChannel(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text);
  return value <= 255 ? value : null;
}

export function fromRgb([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
