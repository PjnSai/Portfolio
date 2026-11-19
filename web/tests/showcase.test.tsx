import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPage } from "@/components/public/ProjectPages";
import { SkillsStrip } from "@/components/public/Sections";
import { Showcase } from "@/components/public/Showcase";
import { pageModel } from "@/lib/public/content";
import { counterText, layoutOf, offsetOf } from "@/lib/public/showcase";
import type { PublicSite } from "@/lib/site";

const project = (title: string, extra = {}) => ({
  id: `id-${title}`,
  data: {
    title, summary: "S.", body: "", status: "live", colour: "blue", tags: [], images: [],
    links: [{ kind: "repository", label: "Code", url: "https://github.test/x" }],
    fields: [{ label: "What I built", value: "All of it" }],
    ...extra,
  },
});

const site = (count: number, settings = {}): PublicSite => ({
  settings,
  palettes: [],
  media: {},
  sections: [
    { type: "projects", title: "Work", items: Array.from({ length: count }, (_, i) => project(`P${i + 1}`)) },
    { type: "skills", title: "Skills", items: [{ id: "s", data: { name: "L", skills: ["Python", "SQL"] } }] },
  ],
});
const html = (s: PublicSite) => renderToStaticMarkup(<Showcase projects={pageModel(s).projects} site={s} />);

describe("showcase offsets", () => {
  it("counts linearly for stack and train", () => {
    expect([0, 1, 2, 3, 4].map((i) => offsetOf(i, 1, 5, false))).toEqual([-1, 0, 1, 2, 3]);
  });

  it("wraps round for the ring layouts", () => {
    expect([0, 1, 2, 3, 4].map((i) => offsetOf(i, 0, 5, true))).toEqual([0, 1, 2, -2, -1]);
    expect([0, 1, 2, 3].map((i) => offsetOf(i, 3, 4, true))).toEqual([1, -2, -1, 0]);
  });

  it("never goes past three either way", () => {
    expect(offsetOf(9, 0, 10, false)).toBe(3);
    expect(offsetOf(0, 9, 10, false)).toBe(-3);
  });

  it("formats the counter with two digits", () => {
    expect(counterText(0, 6)).toBe("01 / 06");
    expect(counterText(11, 12)).toBe("12 / 12");
  });

  it("knows the four layouts and falls back to the ring", () => {
    expect(["ring", "vertical", "stack", "train", "cube", undefined].map(layoutOf)).toEqual([
      "ring", "vertical", "stack", "train", "ring", "ring",
    ]);
  });
});

describe("showcase markup", () => {
  it("prerenders the owner's layout, every card and hidden controls, with no style attribute", () => {
    const out = html(site(3, { showcase_layout: "train" }));
    expect(out).toContain('data-layout="train"');
    expect(out.match(/<article/g)).toHaveLength(3);
    expect(out).toMatch(/data-showcase-controls="true" hidden=""/);
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).toContain("What I built");
  });

  it("offers the layout switcher only when the owner allows it", () => {
    expect(html(site(3))).not.toContain("data-showcase-switch");
    expect(html(site(3, { layout_switcher: true }))).toContain("data-showcase-switch");
  });

  it("labels each dot with the project's place and title", () => {
    expect(html(site(2))).toContain('aria-label="Project 2 of 2: P2"');
  });
});

describe("skills strip", () => {
  it("is real, named text with a hidden pause button and no copy before the script", () => {
    const out = renderToStaticMarkup(<SkillsStrip site={site(1)} />);
    expect(out).toContain('aria-label="Skills strip"');
    expect(out).toMatch(/data-marquee-toggle="true" hidden=""/);
    expect(out).not.toContain("aria-hidden");
    expect(out.match(/<ul/g)).toHaveLength(1);
  });
});

describe("project list pages", () => {
  const s = site(8);
  const page = (n: number) =>
    renderToStaticMarkup(<ProjectPage projects={pageModel(s).projects} site={s} page={n} />);

  it("shows six on the first page with numbered links and aria-current", () => {
    const out = page(1);
    expect(out.match(/<article/g)).toHaveLength(6);
    expect(out).toContain('href="/projects" aria-current="page"');
    expect(out).toContain('href="/projects/page/2" rel="next"');
    expect(out).not.toContain('rel="prev"');
  });

  it("shows the rest on the last page", () => {
    const out = page(2);
    expect(out.match(/<article/g)).toHaveLength(2);
    expect(out).toContain('href="/projects/page/2" aria-current="page"');
    expect(out).toContain('href="/projects" rel="prev"');
    expect(out).not.toContain('rel="next"');
  });

  it("says plainly when a page does not exist", () => {
    const out = page(5);
    expect(out).toContain("There is no page 5 of projects. The list has 2 pages.");
    expect(out).not.toContain("<article");
  });
});
