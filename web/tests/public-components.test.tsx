import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Picture, StatTiles, Tags } from "@/components/public/bits";
import { ProjectCard } from "@/components/public/ProjectCard";
import { SectionBlock } from "@/components/public/Sections";
import { Footer, SectionPager, SiteNav } from "@/components/public/SiteNav";
import { pageModel } from "@/lib/public/content";
import type { PublicSite } from "@/lib/site";

const SITE: PublicSite = {
  settings: {},
  palettes: [],
  media: {
    m1: { width: 960, height: 1200, sources: [
      { width: 480, height: 600, url: "/api/v1/media/a-480.webp" },
      { width: 960, height: 1200, url: "/api/v1/media/a-960.webp" },
    ] },
  },
  sections: [
    { type: "projects", title: "Selected work", items: [{ id: "p1", data: {
      title: "Task board", summary: "One.", body: "", status: "in_progress", colour: "pink",
      tags: ["Python"], links: [], fields: [], images: [{ media: "m1", alt: "Board view" }],
    } }] },
    { type: "education", title: "Study", items: [] },
    { type: "contact", title: "Contact me", body: "", items: [] },
  ],
};
const model = pageModel(SITE);
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("public components", () => {
  it("never write a style attribute", () => {
    const all = html(
      <>
        <SiteNav name="N" sections={model.sections} contact="contact" />
        <SectionPager sections={model.sections} />
        {model.sections.map((entry) => (
          <SectionBlock key={entry.anchor} entry={entry} site={SITE} model={model} />
        ))}
        <Footer name="N" hasProjects />
      </>,
    );
    expect(all).not.toMatch(/\sstyle=/);
  });

  it("nav links are real fragments and the burger starts closed and controls the list", () => {
    const nav = html(<SiteNav name="N" sections={model.sections} contact="contact" />);
    expect(nav).toContain('href="/#projects"');
    expect(nav).toContain('aria-expanded="false"');
    expect(nav).toContain('aria-controls="site-menu"');
    expect(nav).toContain('id="site-menu"');
    expect(nav).toContain('href="/#contact"');
  });

  it("pager links are labelled with the section name", () => {
    const pager = html(<SectionPager sections={model.sections} />);
    expect(pager).toContain('aria-label="Sections"');
    expect(pager).toContain("Go to </span>Projects");
    expect(html(<SectionPager sections={[]} />)).toBe("");
  });

  it("a section has its anchor, a numbered label and a focusable h2", () => {
    const block = html(<SectionBlock entry={model.sections[0]} site={SITE} model={model} />);
    expect(block).toContain('id="projects"');
    expect(block).toContain("01 / Projects");
    expect(block).toMatch(/<h2 id="projects-title" tabindex="-1">Selected work<\/h2>/);
  });

  it("empty sections show a TODO placeholder", () => {
    const block = html(<SectionBlock entry={model.sections[1]} site={SITE} model={model} />);
    expect(block).toContain("TODO: add education.");
    const contact = html(<SectionBlock entry={model.sections[2]} site={SITE} model={model} />);
    expect(contact).toContain("TODO: add professional links.");
  });

  it("a project card takes its colour from a slot and links to its case study", () => {
    const card = html(<ProjectCard project={model.projects[0]} site={SITE} />);
    expect(card).toContain('data-accent="2"');
    expect(card).toContain('href="/projects/task-board"');
    expect(card).toContain("In progress");
    expect(card).toMatch(/<h3/);
  });

  it("pictures use the API widths as a srcset, or a placeholder", () => {
    const img = html(
      <Picture slot={{ media: "m1", alt: "Board view" }} media={SITE.media.m1} sizes="100vw" placeholder="TODO" />,
    );
    expect(img).toContain("a-480.webp 480w");
    expect(img).toContain('alt="Board view"');
    expect(img).toContain('width="960"');
    const empty = html(<Picture slot={undefined} media={undefined} sizes="100vw" placeholder="TODO: portrait" />);
    expect(empty).toContain("TODO: portrait");
    expect(empty).not.toContain("<img");
  });

  it("buttons are ink fill or ink outline; tags and tiles render their content", () => {
    expect(html(<Button href="#x">Go</Button>)).toContain('class="btn btn--fill"');
    expect(html(<Button href="#x" variant="outline">Go</Button>)).toContain("btn--outline");
    expect(html(<Tags tags={["A", "B"]} label="Built with" />)).toContain('aria-label="Built with"');
    expect(html(<Tags tags={[]} label="x" />)).toBe("");
    const tiles = html(<StatTiles stats={[{ value: 2, label: "Projects" }]} />);
    expect(tiles).toContain('data-accent="1"');
    expect(tiles).toContain("Projects");
  });
});
