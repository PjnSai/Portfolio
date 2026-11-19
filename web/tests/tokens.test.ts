import { describe, expect, it } from "vitest";
import { SLOTS } from "@/lib/palettes";
import { defaultPalette, FALLBACK, paletteCss, tokenName, validPalettes } from "@/lib/public/tokens";

const A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4";
const E = "b399fb8f-5de4-462d-98f5-a81bf8046a6f";
const palette = (id: string, bg = "#F3EBDD") => ({
  id,
  name: "Test",
  light: { ...FALLBACK.light, bg },
  dark: { ...FALLBACK.dark, bg: "#17140F" },
});

describe("paletteCss", () => {
  it("writes each palette under its data-palette selector, light then dark", () => {
    const css = paletteCss([palette(E)]);
    expect(css).toContain(`[data-palette="${E}"]{--c-bg:#F3EBDD;`);
    expect(css).toContain(
      `@media (prefers-color-scheme: dark){:root:not([data-theme=light])[data-palette="${E}"],` +
        `:root:not([data-theme=light]) [data-palette="${E}"]{--c-bg:#17140F;`,
    );
    expect(css).toContain(
      `:root[data-theme=dark][data-palette="${E}"],:root[data-theme=dark] [data-palette="${E}"]{--c-bg:#17140F;`,
    );
  });

  it("always has the preset A fallback on :root, light and dark", () => {
    const css = paletteCss([]);
    expect(css).toContain(":root{--c-bg:#F4F2EE;");
    expect(css).toContain("@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--c-bg:#121212;");
    expect(css).toContain(":root[data-theme=dark]{--c-bg:#121212;");
  });

  it("names every slot as a token", () => {
    const css = paletteCss([palette(E)]);
    for (const slot of SLOTS) expect(css).toContain(`${tokenName(slot)}:`);
    expect(tokenName("on_accent_3")).toBe("--c-on-accent-3");
  });

  it.each([
    ["a colour carrying CSS", palette(E, "#FFF;}body{x:y")],
    ["a named colour", palette(E, "red")],
    ["short hex", palette(E, "#FFF")],
    ["an id that is not a UUID", palette('x"]{}body{')],
    ["a missing slot", { ...palette(E), light: { bg: "#FFFFFF" } }],
    ["not an object", "palette"],
  ])("leaves out %s", (_, bad) => {
    expect(validPalettes([bad])).toEqual([]);
    const css = paletteCss([bad]);
    expect(css).not.toContain("body");
    expect(css).not.toContain("[data-palette");
  });
});

describe("defaultPalette", () => {
  it("uses the published default, then the first enabled", () => {
    const list = [palette(E), palette(A)];
    expect(defaultPalette(list, A)?.id).toBe(A);
    expect(defaultPalette(list, "missing")?.id).toBe(E);
    expect(defaultPalette([], A)).toBeUndefined();
  });
});
