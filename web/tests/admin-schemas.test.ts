import { describe, expect, it } from "vitest";
import { flattenErrors } from "@/lib/admin/api";
import { contrast, failures, PAIRS } from "@/lib/admin/contrast";
import {
  issuesByField,
  ITEM_SCHEMAS,
  paletteChoiceSchema,
  paletteSchema,
  SECTION_SCHEMAS,
  settingsSchema,
} from "@/lib/admin/schemas";
import { MODES, type PaletteColours } from "@/lib/palettes";

const ORIGINAL_ID = "b399fb8f-5de4-462d-98f5-a81bf8046a6f";
const OTHER_ID = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4";

// The Original preset, as migration 0010 seeds it.
const ORIGINAL: PaletteColours = {
  light: {
    bg: "#F3EBDD",
    ink: "#17140F",
    surface: "#FBF6EE",
    primary: "#E8551C",
    on_primary: "#17140F",
    accent_1: "#2B57C9",
    on_accent_1: "#FFFFFF",
    accent_2: "#F2A6C6",
    on_accent_2: "#17140F",
    accent_3: "#F2B835",
    on_accent_3: "#17140F",
    accent_4: "#5E621C",
    on_accent_4: "#FFFFFF",
  },
  dark: {
    bg: "#17140F",
    ink: "#F3EBDD",
    surface: "#24201A",
    primary: "#FF5A1F",
    on_primary: "#17140F",
    accent_1: "#6E93F0",
    on_accent_1: "#17140F",
    accent_2: "#F2A6C6",
    on_accent_2: "#17140F",
    accent_3: "#F2B835",
    on_accent_3: "#17140F",
    accent_4: "#A9AE4A",
    on_accent_4: "#17140F",
  },
};

const palette = { name: "Mine", ...structuredClone(ORIGINAL) };

const project = {
  title: "Ledger",
  summary: "",
  body: "",
  status: "local",
  created: "2024-03",
  category: "Web",
  colour: "blue",
  tags: ["Python"],
  links: [{ kind: "repository", label: "Code", url: "https://github.test/o/r" }],
  fields: [{ label: "Role", value: "Sole developer" }],
  images: [{ media: null, alt: "Dashboard", caption: "" }],
};

const settings = {
  title: "Pujan Shahi",
  description: "",
  contact_form: true,
  showcase_layout: "ring",
  layout_switcher: false,
  palette_mode: "fixed",
  default_palette_id: ORIGINAL_ID,
  enabled_palette_ids: [ORIGINAL_ID],
};

const refused = (result: { success: boolean }) => expect(result.success).toBe(false);
const accepted = (result: { success: boolean; error?: unknown }) =>
  expect(result.success, JSON.stringify(result.error)).toBe(true);

describe("item schemas", () => {
  it("accept a full project", () => {
    accepted(ITEM_SCHEMAS.projects.safeParse(project));
  });

  it.each([
    ["title", "x".repeat(121)],
    ["title", ""],
    ["title", "two\nlines"],
    ["title", "null\u0000byte"],
    ["summary", "x".repeat(501)],
    ["body", "x".repeat(20001)],
    ["status", "finished"],
    ["colour", "purple"],
    ["created", "2024-13"],
    ["category", "x".repeat(41)],
    ["tags", ["Python", "python"]],
    ["tags", Array.from({ length: 31 }, (_, n) => `t${n}`)],
    ["tags", ["x".repeat(41)]],
    ["links", [{ kind: "demo", label: "x", url: "javascript:alert(1)" }]],
    ["links", [{ kind: "demo", label: "x", url: "http://plain.test/" }]],
    ["links", [{ kind: "blog", label: "x", url: "https://ok.test/" }]],
    ["links", Array.from({ length: 11 }, () => project.links[0])],
    ["fields", [{ label: "x".repeat(61), value: "v" }]],
    ["fields", [{ label: "Role", value: "x".repeat(301) }]],
    ["images", [{ media: null, alt: "", caption: "" }]],
    ["images", [{ media: "not-an-id", alt: "x", caption: "" }]],
    ["images", Array.from({ length: 9 }, () => project.images[0])],
  ])("refuse %s = %j", (field, value) => {
    refused(ITEM_SCHEMAS.projects.safeParse({ ...project, [field]: value }));
  });

  it("refuse fields the server does not know", () => {
    refused(ITEM_SCHEMAS.projects.safeParse({ ...project, published: {} }));
    refused(
      ITEM_SCHEMAS.projects.safeParse({
        ...project,
        links: [{ ...project.links[0], onclick: "x" }],
      }),
    );
  });

  it("refuse an end before the start", () => {
    refused(
      ITEM_SCHEMAS.experience.safeParse({
        organisation: "TODO",
        role: "TODO",
        start: "2024-09",
        end: "2023-01",
        summary: "",
      }),
    );
  });

  it("accept a skill group and refuse a repeated skill", () => {
    accepted(ITEM_SCHEMAS.skills.safeParse({ name: "Languages", skills: ["Python"] }));
    refused(ITEM_SCHEMAS.skills.safeParse({ name: "L", skills: ["Go", "go"] }));
  });
});

describe("section schemas", () => {
  it("know the hero and about fields", () => {
    accepted(
      SECTION_SCHEMAS.hero.safeParse({
        title: "Intro",
        body: "",
        name: "Pujan Shahi",
        role: "TODO: role",
        availability: "",
      }),
    );
    refused(SECTION_SCHEMAS.hero.safeParse({ title: "Intro", body: "x".repeat(1001) }));
    refused(SECTION_SCHEMAS.text.safeParse({ title: "T", body: "", name: "x" }));
    refused(
      SECTION_SCHEMAS.about.safeParse({ title: "A", body: "", photo: { media: null, alt: "" } }),
    );
  });
});

describe("settings schema", () => {
  it("accepts the defaults", () => {
    accepted(settingsSchema.safeParse(settings));
  });

  it("refuses an unknown layout and an unknown SEO page", () => {
    refused(settingsSchema.safeParse({ ...settings, showcase_layout: "carousel" }));
    refused(settingsSchema.safeParse({ ...settings, seo: { blog: { title: "x" } } }));
  });

  it("no longer takes the old theme field", () => {
    refused(settingsSchema.safeParse({ ...settings, theme: {} }));
  });

  it.each([
    { palette_mode: "random" },
    { enabled_palette_ids: [] },
    { default_palette_id: OTHER_ID },
    { default_palette_id: "not-an-id" },
  ])("refuses the palette choice %o", (change) => {
    refused(settingsSchema.safeParse({ ...settings, ...change }));
    refused(paletteChoiceSchema.safeParse({ ...settings, ...change, title: undefined }));
  });

  it("accepts a choice whose default is enabled", () => {
    accepted(
      paletteChoiceSchema.safeParse({
        palette_mode: "rotate",
        default_palette_id: OTHER_ID,
        enabled_palette_ids: [ORIGINAL_ID, OTHER_ID],
      }),
    );
  });
});

describe("palette schema", () => {
  it("accepts the Original preset", () => {
    accepted(paletteSchema.safeParse(palette));
  });

  it.each(["red", "#fff", "#E2531B;}", "var(--x)", "url(x)", "#E2531BFF", ""])(
    "refuses colour %s",
    (colour) => {
      refused(paletteSchema.safeParse({ ...palette, light: { ...palette.light, primary: colour } }));
    },
  );

  it("refuses a missing or extra slot", () => {
    const missing: Record<string, string> = { ...palette.dark };
    delete missing.accent_4;
    refused(paletteSchema.safeParse({ ...palette, dark: missing }));
    refused(paletteSchema.safeParse({ ...palette, dark: { ...palette.dark, accent_5: "#000000" } }));
    refused(paletteSchema.safeParse({ ...palette, kind: "preset" }));
  });

  it("refuses a pair that fails contrast, under the mode", () => {
    const result = paletteSchema.safeParse({ ...palette, dark: { ...palette.dark, ink: "#24201A" } });
    if (result.success) throw new Error("expected failure");
    expect(issuesByField(result.error).dark[0]).toMatch(/^Dark: ink on bg is/);
  });
});

describe("issuesByField", () => {
  it("groups messages by top-level field and names the row", () => {
    const result = ITEM_SCHEMAS.projects.safeParse({
      ...project,
      title: "",
      links: [project.links[0], { kind: "demo", label: "x", url: "ftp://x" }],
    });
    if (result.success) throw new Error("expected failure");

    const fields = issuesByField(result.error);

    expect(Object.keys(fields).sort()).toEqual(["links", "title"]);
    expect(fields.links[0]).toMatch(/^Row 2: /);
  });
});

describe("flattenErrors", () => {
  it("turns nested API errors into one list per top-level field", () => {
    expect(
      flattenErrors({
        title: ["Too long."],
        links: [{}, { url: ["Use a full https:// address."] }],
        theme: { non_field_errors: ["Light theme: text is 2:1."] },
      }),
    ).toEqual({
      title: ["Too long."],
      links: ["Row 2: Use a full https:// address."],
      theme: ["Light theme: text is 2:1."],
    });
  });

  it("ignores anything that is not an object", () => {
    expect(flattenErrors(undefined)).toEqual({});
    expect(flattenErrors("x")).toEqual({});
  });
});

describe("contrast", () => {
  it.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#777777", "#ffffff", 4.48],
    ["#767676", "#ffffff", 4.54],
  ])("%s on %s is %d:1", (one, two, ratio) => {
    expect(contrast(one, two)).toBeCloseTo(ratio, 2);
  });

  it("passes the Original preset", () => {
    expect(failures(ORIGINAL)).toEqual([]);
  });

  it("checks the same pairs as the API", () => {
    expect(PAIRS.map((p) => `${p.front}/${p.back}/${p.minimum}`)).toEqual([
      "ink/bg/4.5",
      "ink/surface/4.5",
      "on_primary/primary/4.5",
      "on_accent_1/accent_1/4.5",
      "on_accent_2/accent_2/4.5",
      "on_accent_3/accent_3/4.5",
      "on_accent_4/accent_4/4.5",
      "primary/bg/3",
    ]);
  });

  it.each(MODES.flatMap((mode) => PAIRS.map((pair) => [mode, pair] as const)))(
    "names a failing pair in %s: %o",
    (mode, pair) => {
      const colours = structuredClone(ORIGINAL);
      colours[mode][pair.front] = colours[mode][pair.back];
      const found = failures(colours);
      expect(found.map((f) => f.message)).toContain(
        `${mode === "light" ? "Light" : "Dark"}: ${pair.front} on ${pair.back} is 1.00:1; it needs at least ${pair.minimum}:1.`,
      );
      expect(found.every((f) => f.mode === mode)).toBe(true);
    },
  );
});
