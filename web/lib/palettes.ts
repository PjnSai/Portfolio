// Palette shapes shared by the public site and the admin. The API defines them
// (api/core/theme.py and api/core/serializers.py); colours are #RRGGBB.

export const MODES = ["light", "dark"] as const;
export type PaletteMode = (typeof MODES)[number];

export const SLOTS = [
  "bg",
  "ink",
  "surface",
  "primary",
  "on_primary",
  "accent_1",
  "accent_2",
  "accent_3",
  "accent_4",
  "on_accent_1",
  "on_accent_2",
  "on_accent_3",
  "on_accent_4",
] as const;
export type Slot = (typeof SLOTS)[number];

export type Slots = Record<Slot, string>;
export type PaletteColours = Record<PaletteMode, Slots>;

/** A palette as GET /api/v1/site lists it: only the enabled ones are sent. */
export type SitePalette = PaletteColours & { id: string; name: string };

export const PALETTE_MODES = ["fixed", "rotate", "pick"] as const;
export type PaletteUse = (typeof PALETTE_MODES)[number];

export type PaletteChoice = {
  palette_mode: PaletteUse;
  default_palette_id: string;
  enabled_palette_ids: string[];
};

/** A palette as the admin API returns it. */
export type AdminPalette = SitePalette & {
  kind: "preset" | "custom";
  created_at: string;
  updated_at: string;
};

export const MAX_CUSTOM_PALETTES = 12;
