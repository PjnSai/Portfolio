import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRgb, parseChannel, parseHex, toRgb } from "@/lib/admin/colour";
import { checks, contrast, failures, PAIRS, shown } from "@/lib/admin/contrast";
import { serverErrors } from "@/lib/admin/palette-errors";
import type { PaletteColours, Slots } from "@/lib/palettes";

// The same file is checked by api/tests/test_palettes.py, so both sides agree.
type Vectors = {
  ratios: { one: string; two: string; ratio: number }[];
  palettes: (PaletteColours & { name: string; failures: string[] })[];
};
const VECTORS: Vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../api/tests/contrast_vectors.json"), "utf8"),
);

describe("client contrast copy", () => {
  it.each(VECTORS.ratios)("$one on $two is $ratio", ({ one, two, ratio }) => {
    expect(Number(shown(contrast(one, two)))).toBe(ratio);
  });

  it.each(VECTORS.palettes)("$name fails the same pairs as the API", (palette) => {
    expect(failures(palette).map((f) => f.message)).toEqual(palette.failures);
  });

  it("has no rule for the primary against the page", () => {
    expect(PAIRS.some((p) => p.front === "primary" || (p.front === "ink" && p.back === "primary"))).toBe(false);
    expect(PAIRS).toContainEqual({ front: "on_primary", back: "primary", minimum: 4.5 });
  });

  it("gives every pair a ratio and a pass or fail", () => {
    const light: Slots = VECTORS.palettes[0].light;
    const found = checks("light", light);
    expect(found).toHaveLength(PAIRS.length);
    expect(found.every((check) => check.passes)).toBe(true);
  });

  it("skips colours that are not #RRGGBB", () => {
    const light = { ...VECTORS.palettes[0].light, ink: "#FFF" };
    expect(checks("light", light).map((c) => c.front)).not.toContain("ink");
  });
});

describe("colour fields", () => {
  it.each([
    ["#ff5a1f", "#FF5A1F"],
    ["FF5A1F", "#FF5A1F"],
    [" #17140f ", "#17140F"],
    ["#FFF", null],
    ["red", null],
    ["#FF5A1F;}", null],
    ["url(x)", null],
    ["", null],
  ])("parseHex(%j) is %j", (text, expected) => {
    expect(parseHex(text)).toBe(expected);
  });

  it("goes from hex to R/G/B and back", () => {
    expect(toRgb("#FF5A1F")).toEqual([255, 90, 31]);
    expect(fromRgb([255, 90, 31])).toBe("#FF5A1F");
    expect(fromRgb([0, 0, 0])).toBe("#000000");
  });

  it.each([
    ["0", 0],
    ["255", 255],
    ["256", null],
    ["-1", null],
    ["1.5", null],
    ["", null],
    ["12a", null],
  ])("parseChannel(%j) is %j", (text, expected) => {
    expect(parseChannel(text)).toBe(expected);
  });
});

describe("API palette errors", () => {
  it("puts a pair failure next to both slots of the pair", () => {
    const found = serverErrors({ dark: ["Dark: on_primary on primary is 3.12:1; it needs at least 4.5:1."] });
    expect(found.slots["dark.on_primary"]).toHaveLength(1);
    expect(found.slots["dark.primary"]).toHaveLength(1);
    expect(found.slots["light.primary"]).toBeUndefined();
  });

  it("puts a format error next to its slot and keeps name errors apart", () => {
    const found = serverErrors({ name: ["Too long."], light: { accent_2: ["Use a colour like #1A2B3C."] } });
    expect(found.name).toEqual(["Too long."]);
    expect(found.slots["light.accent_2"]).toEqual(["Use a colour like #1A2B3C."]);
  });

  it("keeps other messages under the mode and ignores junk", () => {
    expect(serverErrors({ light: ["Something else."] }).slots["light.general"]).toEqual(["Something else."]);
    expect(serverErrors(undefined)).toEqual({ name: [], slots: {} });
    expect(serverErrors("x")).toEqual({ name: [], slots: {} });
  });
});
