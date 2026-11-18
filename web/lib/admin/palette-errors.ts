// Where the API's palette errors belong in the editor: the name, one slot, or
// both slots of a failing pair. The API is the authority on what is saved.

import { MODES } from "@/lib/palettes";

export type ServerErrors = { name: string[]; slots: Record<string, string[]> };

export const NO_ERRORS: ServerErrors = { name: [], slots: {} };

const PAIR_MESSAGE = /^(?:Light|Dark): (\w+) on (\w+) is /;

/** Keys are "light.primary", "dark.on_accent_2" or "light.general". */
export function serverErrors(errors: unknown): ServerErrors {
  const raw = (errors && typeof errors === "object" ? errors : {}) as Record<string, unknown>;
  const found: ServerErrors = { name: [], slots: {} };
  const add = (key: string, message: string) => {
    found.slots[key] = [...(found.slots[key] ?? []), message];
  };
  if (Array.isArray(raw.name)) found.name = raw.name.map(String);
  for (const mode of MODES) {
    const value = raw[mode];
    if (Array.isArray(value)) {
      for (const message of value.map(String)) {
        const pair = PAIR_MESSAGE.exec(message);
        if (pair) {
          add(`${mode}.${pair[1]}`, message);
          add(`${mode}.${pair[2]}`, message);
        } else {
          add(`${mode}.general`, message);
        }
      }
    } else if (value && typeof value === "object") {
      for (const [slot, messages] of Object.entries(value)) {
        for (const message of [messages].flat().map(String)) add(`${mode}.${slot}`, message);
      }
    }
  }
  return found;
}
