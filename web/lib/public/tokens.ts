// The published palettes as CSS custom properties, written into each page at
// build time. The API only stores #RRGGBB and UUID ids, but this is checked
// again here: anything else is left out, so no CSS can ride in on a value.

import { SLOTS, type SitePalette, type Slots } from "../palettes";

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

function declarations(slots: Slots): string {
  return SLOTS.map((slot) => `${tokenName(slot)}:${slots[slot].toUpperCase()}`).join(";");
}

const dark = (rule: string) => `@media (prefers-color-scheme: dark){${rule}}`;

/** CSS for the fallback on :root and each palette under [data-palette="<id>"]. */
export function paletteCss(palettes: readonly unknown[]): string {
  const rules = [
    `:root{${declarations(FALLBACK.light)}}`,
    dark(`:root{${declarations(FALLBACK.dark)}}`),
  ];
  for (const palette of validPalettes(palettes)) {
    const selector = `[data-palette="${palette.id}"]`;
    rules.push(`${selector}{${declarations(palette.light)}}`);
    rules.push(dark(`${selector}{${declarations(palette.dark)}}`));
  }
  return rules.join("\n");
}
