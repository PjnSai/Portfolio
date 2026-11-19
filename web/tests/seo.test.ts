import { describe, expect, it } from "vitest";
import { pageModel } from "@/lib/public/content";
import { homeMetadata, listMetadata, personData, projectMetadata } from "@/lib/public/meta";
import { listRoutes } from "@/lib/public/pagination";
import {
  absoluteUrl,
  BLOCKED_AGENTS,
  DESCRIPTION_LENGTH,
  firstText,
  jsonLd,
  LOCAL_SITE_ORIGIN,
  plainText,
  siteOrigin,
  sitemapRoutes,
  trimText,
} from "@/lib/seo";
import type { PublicSite } from "@/lib/site";

describe("siteOrigin", () => {
  it.each([
    ["https://pujan.test", "https://pujan.test"],
    ["https://pujan.test/", "https://pujan.test"],
    ["  https://www.pujan.test  ", "https://www.pujan.test"],
    ["http://localhost:3100", "http://localhost:3100"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ])("%s gives %s", (raw, origin) => {
    expect(siteOrigin({ SITE_ORIGIN: raw })).toBe(origin);
  });

  it("uses the documented local default when unset outside Pages", () => {
    expect(siteOrigin({})).toBe(LOCAL_SITE_ORIGIN);
    expect(siteOrigin({ SITE_ORIGIN: "" })).toBe("http://localhost:3000");
  });

  it("fails a Pages build without it, saying what to set", () => {
    expect(() => siteOrigin({ CF_PAGES: "1" })).toThrow(/SITE_ORIGIN is not set.*https:\/\/example\.com/);
  });

  it.each([
    "http://pujan.test",
    "ftp://pujan.test",
    "https://pujan.test/path",
    "https://pujan.test/?q=1",
    "https://pujan.test/#top",
    "https://user:pw@pujan.test",
    "pujan.test",
  ])("refuses %s", (raw) => {
    expect(() => siteOrigin({ SITE_ORIGIN: raw })).toThrow(/SITE_ORIGIN/);
  });

  it("refuses localhost for a Pages build", () => {
    expect(() => siteOrigin({ SITE_ORIGIN: "http://localhost:3000", CF_PAGES: "1" })).toThrow(/cannot be localhost/);
  });
});

describe("absoluteUrl", () => {
  it("puts the origin in front of a site path", () => {
    expect(absoluteUrl("/", "https://pujan.test")).toBe("https://pujan.test/");
    expect(absoluteUrl("/projects/page/2", "https://pujan.test")).toBe("https://pujan.test/projects/page/2");
  });

  it.each(["projects", "//evil.test/x", "https://evil.test/"])("refuses %s", (path) => {
    expect(() => absoluteUrl(path, "https://pujan.test")).toThrow();
  });
});

describe("descriptions", () => {
  it("turns Markdown into one line of text", () => {
    expect(plainText("## Title\n\nA **bold** [link](https://x.test) and `code`.\n\n- one\n- two")).toBe(
      "Title A bold link and code. one two",
    );
  });

  it("leaves short text alone and cuts long text at a word", () => {
    expect(trimText("Short text.")).toBe("Short text.");
    const long = "word ".repeat(60);
    const cut = trimText(long);
    expect(cut.length).toBeLessThanOrEqual(DESCRIPTION_LENGTH);
    expect(cut).toMatch(/word…$/);
  });

  it("skips empty values and TODO markers", () => {
    expect(firstText(undefined, "", "TODO: one-line description", 4, "Real text")).toBe("Real text");
    expect(firstText("TODO: x")).toBe("");
  });
});

describe("jsonLd", () => {
  it("cannot end the script element or break a line", () => {
    const text = jsonLd({ name: "</script><script>alert(1)</script>&\u2028\u2029" });
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual({ name: "</script><script>alert(1)</script>&\u2028\u2029" });
  });
});

describe("sitemapRoutes", () => {
  const footer = ["/privacy", "/security"];

  it("lists home, the list pages that exist, each project and the footer pages", () => {
    expect(
      sitemapRoutes({
        hasContent: true,
        listRoutes: listRoutes(8),
        projectSlugs: ["task-board", "log-parser"],
        footerRoutes: footer,
      }),
    ).toEqual([
      "/",
      "/projects",
      "/projects/page/2",
      "/projects/task-board",
      "/projects/log-parser",
      "/privacy",
      "/security",
    ]);
  });

  it("never lists the page built past the end, /desk or the 404 page", () => {
    const routes = sitemapRoutes({
      hasContent: true,
      listRoutes: listRoutes(6),
      projectSlugs: ["a"],
      footerRoutes: footer,
    });
    expect(routes).not.toContain("/projects/page/2");
    expect(routes.some((route) => route.startsWith("/desk") || route.includes("404"))).toBe(false);
  });

  it("leaves out the project list with no projects, and home before anything is published", () => {
    expect(sitemapRoutes({ hasContent: true, listRoutes: ["/projects"], projectSlugs: [], footerRoutes: [] })).toEqual(["/"]);
    expect(sitemapRoutes({ hasContent: false, listRoutes: ["/projects"], projectSlugs: [], footerRoutes: footer })).toEqual(
      footer,
    );
  });

  it("asks AI crawlers to stay away but no search engine", () => {
    expect(BLOCKED_AGENTS).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"]));
    for (const engine of ["Googlebot", "Bingbot", "DuckDuckBot"]) expect(BLOCKED_AGENTS).not.toContain(engine);
  });
});

const project = (title: string, slug: string, summary = "") => ({
  id: `id-${slug}`,
  slug,
  data: { title, summary, body: "", status: "live", colour: "blue", tags: ["Go"], links: [], fields: [], images: [] },
});

const SITE = {
  settings: { title: "Site", description: "TODO: one-line description of the site" },
  palettes: [],
  media: {},
  sections: [
    { type: "hero", title: "Hero", name: "Pujan Shahi", role: "Software developer", body: "Builds **secure** web apps." },
    {
      type: "projects",
      title: "Work",
      items: Array.from({ length: 7 }, (_, i) => project(`Project ${i + 1}`, `p-${i + 1}`, i === 0 ? "A board." : "")),
    },
    { type: "links", title: "Links", items: [{ id: "l", data: { label: "GitHub", url: "https://github.test/o" } }] },
  ],
} as unknown as PublicSite;

describe("page metadata", () => {
  const model = pageModel(SITE);

  it("gives home an absolute canonical, the owner's words and preview tags", () => {
    const meta = homeMetadata(SITE, model);
    expect(meta.title).toEqual({ absolute: "Pujan Shahi | Software developer" });
    expect(meta.description).toBe("Builds secure web apps.");
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/");
    expect(meta.openGraph).toMatchObject({ url: "http://localhost:3000/", locale: "en_GB" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("prefers the owner's SEO settings", () => {
    const site = { ...SITE, settings: { seo: { home: { title: "Pujan", description: "Owner words." } } } } as PublicSite;
    const meta = homeMetadata(site, pageModel(site));
    expect(meta.title).toEqual({ absolute: "Pujan" });
    expect(meta.description).toBe("Owner words.");
  });

  it("uses the project's summary, or a plain fallback", () => {
    expect(projectMetadata(model, model.projects[0]).description).toBe("A board.");
    expect(projectMetadata(model, model.projects[1])).toMatchObject({
      description: "Project 2, a project by Pujan Shahi.",
      alternates: { canonical: "http://localhost:3000/projects/p-2" },
    });
  });

  it("links list pages to each other and hides the page past the end", () => {
    const second = listMetadata(SITE, model, 2);
    expect(second.alternates?.canonical).toBe("http://localhost:3000/projects/page/2");
    expect(second.pagination).toEqual({ previous: "http://localhost:3000/projects", next: undefined });
    const past = listMetadata(SITE, model, 3);
    expect(past.robots).toEqual({ index: false, follow: false });
    expect(past.alternates).toBeUndefined();
  });

  it("describes the owner as a Person with professional links only", () => {
    expect(personData(SITE, model)).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: "Pujan Shahi",
      url: "http://localhost:3000/",
      jobTitle: "Software developer",
      sameAs: ["https://github.test/o"],
    });
  });
});
