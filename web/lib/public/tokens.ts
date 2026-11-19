// The published palettes as CSS custom properties, written into each page at
// build time. The API only stores #RRGGBB and UUID ids, but this is checked
// again here: anything else is left out, so no CSS can ride in on a value.

import { PALETTE_MODES, type PaletteUse, SLOTS, type SitePalette, type Slots } from "../palettes";

const HEX = /^#[0-9A-Fa-f]{6}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WHITE = "#FFFFFF";

/** Preset A, used before the first settings publish (same values as migration 0010). */
export const FALLBACK: Pick<SitePalette, "light" | "dark"> = {
  light: {
    bg: "#F4F2EE",
    ink: "#111111",
    surface: WHITE,
    primary: "#D7261E",
    on_primary: WHITE,
    accent_1: "#111111",
    on_accent_1: "#F4F2EE",
    accent_2: "#F2C230",
    on_accent_2: "#111111",
    accent_3: "#8A8F98",
    on_accent_3: "#111111",
    accent_4: "#1F4E9C",
    on_accent_4: WHITE,
  },
  dark: {
    bg: "#121212",
    ink: "#F4F2EE",
    surface: "#1E1E1E",
    primary: "#FF4B3E",
    on_primary: "#121212",
    accent_1: "#F4F2EE",
    on_accent_1: "#121212",
    accent_2: "#F2C230",
    on_accent_2: "#121212",
    accent_3: "#8A8F98",
    on_accent_3: "#121212",
    accent_4: "#6E9BE8",
    on_accent_4: "#121212",
  },
};

/** The custom property for a slot: on_accent_1 is --c-on-accent-1. */
export const tokenName = (slot: string) => `--c-${slot.replace(/_/g, "-")}`;

function validSlots(value: unknown): value is Slots {
  if (!value || typeof value !== "object") return false;
  const slots = value as Record<string, unknown>;
  return SLOTS.every((slot) => typeof slots[slot] === "string" && HEX.test(slots[slot]));
}

/** Only palettes whose id and every colour are well formed. */
export function validPalettes(palettes: readonly unknown[]): SitePalette[] {
  return palettes.filter((palette): palette is SitePalette => {
    if (!palette || typeof palette !== "object") return false;
    const found = palette as Record<string, unknown>;
    return (
      typeof found.id === "string" &&
      ID.test(found.id) &&
      validSlots(found.light) &&
      validSlots(found.dark)
    );
  });
}

/** The palette the page starts on: the published default if it is usable. */
export function defaultPalette(
  palettes: readonly SitePalette[],
  wanted: string | undefined,
): SitePalette | undefined {
  return palettes.find((palette) => palette.id === wanted) ?? palettes[0];
}

/** The published mode; anything unknown is treated as fixed. */
export function paletteMode(value: unknown): PaletteUse {
  return PALETTE_MODES.find((mode) => mode === value) ?? "fixed";
}

function declarations(slots: Slots): string {
  return SLOTS.map((slot) => `${tokenName(slot)}:${slots[slot].toUpperCase()}`).join(";");
}

/**
 * Selectors for the dark values of `base`: on <html> itself and on anything
 * inside it that names a palette (the picker's swatches). Dark applies when
 * the visitor chose dark, or follows the system unless they chose light.
 */
function darkRules(base: string, slots: Slots): string[] {
  const body = `{${declarations(slots)}}`;
  const system = ":root:not([data-theme=light])";
  const chosen = ":root[data-theme=dark]";
  const on = (root: string) => (base === ":root" ? root : `${root}${base},${root} ${base}`);
  return [`@media (prefers-color-scheme: dark){${on(system)}${body}}`, `${on(chosen)}${body}`];
}

/**
 * CSS for the fallback on :root and each palette under [data-palette="<id>"],
 * light first, then dark. data-theme on <html> (set by the inline script) is
 * "light", "dark" or "system"; with no script the system setting decides.
 */
export function paletteCss(palettes: readonly unknown[]): string {
  const rules = [`:root{${declarations(FALLBACK.light)}}`, ...darkRules(":root", FALLBACK.dark)];
  for (const palette of validPalettes(palettes)) {
    const selector = `[data-palette="${palette.id}"]`;
    rules.push(`${selector}{${declarations(palette.light)}}`);
    rules.push(...darkRules(selector, palette.dark));
  }
  return rules.join("\n");
}
