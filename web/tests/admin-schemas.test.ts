import { describe, expect, it } from "vitest";
import { flattenErrors } from "@/lib/admin/api";
import { contrast, DEFAULT_THEME, failures } from "@/lib/admin/contrast";
import {
  issuesByField,
  ITEM_SCHEMAS,
  SECTION_SCHEMAS,
  settingsSchema,
} from "@/lib/admin/schemas";

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
  theme: DEFAULT_THEME,
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

  it.each(["red", "#fff", "#e2531b;}", "var(--x)"])("refuses colour %s", (colour) => {
    const theme = { ...DEFAULT_THEME, light: { ...DEFAULT_THEME.light, accent: colour } };
    refused(settingsSchema.safeParse({ ...settings, theme }));
  });

  it("refuses a pair that fails contrast", () => {
    const theme = { ...DEFAULT_THEME, light: { ...DEFAULT_THEME.light, ink: "#bbbbbb" } };
    refused(settingsSchema.safeParse({ ...settings, theme }));
  });

  it("refuses an unknown layout and an unknown SEO page", () => {
    refused(settingsSchema.safeParse({ ...settings, showcase_layout: "carousel" }));
    refused(settingsSchema.safeParse({ ...settings, seo: { blog: { title: "x" } } }));
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

  it("passes the default theme", () => {
    expect(failures(DEFAULT_THEME)).toEqual([]);
  });

  it("names each failing pair", () => {
    const theme = {
      ...DEFAULT_THEME,
      dark: { ...DEFAULT_THEME.dark, on_accent: "#f5efe3" },
    };
    const found = failures(theme);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mode: "dark", front: "on_accent", back: "accent" });
  });
});
