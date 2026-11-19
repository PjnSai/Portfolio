import { describe, expect, it } from "vitest";
import {
  accentFor,
  dateRange,
  pageModel,
  slugify,
  statsFor,
  uniqueSlugs,
} from "@/lib/public/content";
import type { PublicSite } from "@/lib/site";

const project = (title: string, extra = {}) => ({
  id: `id-${title}`,
  data: { title, summary: "", body: "", status: "live", colour: "blue", tags: [], links: [], fields: [], images: [], ...extra },
});

const SITE: PublicSite = {
  settings: { title: "Site title" },
  palettes: [],
  media: {},
  sections: [
    { type: "hero", title: "Hero", name: "Pujan Shahi", items: [] },
    { type: "projects", title: "Selected work", items: [project("Task board"), project("Task board")] },
    { type: "text", title: "Notes on work", items: [] },
    { type: "experience", title: "Work", items: [{ id: "e", data: {} }] },
    { type: "skills", title: "Toolkit", items: [{ id: "s", data: { name: "L", skills: ["Python", "SQL"] } }] },
    { type: "links", title: "Elsewhere", items: [{ id: "l", data: { label: "GitHub", url: "https://github.test/x" } }] },
    { type: "contact", title: "Contact me", items: [] },
  ],
};

describe("pageModel", () => {
  const model = pageModel(SITE);

  it("keeps the owner's order, numbers sections after the hero and folds links into contact", () => {
    expect(model.sections.map((s) => [s.number, s.anchor, s.label])).toEqual([
      ["01", "projects", "Projects"],
      ["02", "notes-on-work", "Notes on work"],
      ["03", "experience", "Experience"],
      ["04", "skills", "Skills"],
      ["05", "contact", "Contact"],
    ]);
    expect(model.contact?.anchor).toBe("contact");
    expect(model.links).toEqual([{ label: "GitHub", url: "https://github.test/x" }]);
  });

  it("names the page from the hero, then the settings", () => {
    expect(model.name).toBe("Pujan Shahi");
    expect(pageModel({ ...SITE, sections: [] }).name).toBe("Site title");
    expect(pageModel({ ...SITE, settings: {}, sections: [] }).name).toBe("Portfolio");
  });

  it("gives projects unique slugs", () => {
    expect(model.projects.map((p) => p.slug)).toEqual(["task-board", "task-board-2"]);
  });

  it("counts only what is published and leaves zero counts out", () => {
    expect(statsFor(SITE, model)).toEqual([
      { value: 2, label: "Projects" },
      { value: 1, label: "Role" },
      { value: 2, label: "Skills" },
    ]);
  });

  it("keeps a repeated section type's anchor unique and away from reserved ids", () => {
    const twice = pageModel({
      ...SITE,
      sections: [
        { type: "about", title: "A", items: [] },
        { type: "about", title: "B", items: [] },
        { type: "text", title: "Main", items: [] },
      ],
    });
    expect(twice.sections.map((s) => s.anchor)).toEqual(["about", "about-2", "main-2"]);
  });
});

describe("helpers", () => {
  it.each([
    ["Café & Bar!", "cafe-bar"],
    ["  ", "section"],
    ["<script>", "script"],
  ])("slugify(%j)", (input, out) => expect(slugify(input)).toBe(out));

  it("uniqueSlugs avoids taken names", () => {
    expect(uniqueSlugs(["top", "top"], ["top"])).toEqual(["top-2", "top-3"]);
  });

  it("maps card colours to slots and anything else to primary", () => {
    expect(["orange", "blue", "pink", "yellow", "olive", "ink", "url(x)"].map(accentFor)).toEqual([
      "primary", "1", "2", "3", "4", "ink", "primary",
    ]);
  });

  it("shows dates as months, with an open end as now", () => {
    expect(dateRange("2024-01", "2025-06")).toBe("Jan 2024 to Jun 2025");
    expect(dateRange("2024-01", undefined)).toBe("Jan 2024 to now");
  });
});
