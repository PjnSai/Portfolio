import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BOOT_SCRIPT } from "@/lib/public/boot-script";

const SCRIPT = fileURLToPath(new URL("../scripts/check-export.ts", import.meta.url));
const HIDDEN = '<title>T</title><meta name="robots" content="noindex, nofollow"/>';
const page = (body: string, head = HIDDEN) =>
  `<!DOCTYPE html><html><head><script>${BOOT_SCRIPT}</script>${head}</head><body>${body}</body></html>`;

const ORIGIN = "http://localhost:3000";
/** The head tags of a page open to search, as Next writes them. */
function seoHead(route: string, { canonical = `${ORIGIN}${route}`, extra = "" } = {}) {
  return [
    "<title>T</title>",
    '<meta name="description" content="D"/>',
    `<link rel="canonical" href="${canonical}"/>`,
    `<meta property="og:url" content="${canonical}"/>`,
    `<meta property="og:image" content="${ORIGIN}/og-default.png"/>`,
    '<meta name="twitter:card" content="summary_large_image"/>',
    extra,
  ].join("");
}
const PERSON = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"N"}</script>';
const sitemap = (...routes: string[]) =>
  `<urlset>${routes.map((r) => `<url><loc>${ORIGIN}${r}</loc></url>`).join("")}</urlset>`;
const ROBOTS = `User-Agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;
const indexed = {
  "out/index.html": page(PERSON, seoHead("/")),
  "out/projects.html": page("", seoHead("/projects")),
  "out/sitemap.xml": sitemap("/", "/projects"),
  "out/robots.txt": ROBOTS,
  "out/.well-known/security.txt": `Contact: https://report.test
Expires: ${new Date(Date.now() + 864e5).toISOString()}
`,
};

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function exportWith(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "check-export-"));
  const all = { "out/index.html": page(""), "out/404.html": page(""), "out/_headers": "", ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    // No build secrets: the leak check compares against the environment.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
  });
}

describe("check:export", () => {
  it("passes a clean export with list pages", () => {
    const run = exportWith({ "out/projects/page/2.html": page("<p>Two</p>") });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fails if a list page has a style attribute", () => {
    const run = exportWith({ "out/projects/page/2.html": page('<p style="color:red">Two</p>') });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/style attribute: out.projects.page.2.html/);
  });

  it("prints home's initial JS and fails a page over 150 kB gzipped", () => {
    const big = randomBytes(160_000).toString("latin1");
    const pass = exportWith({
      "out/index.html": page('<script src="/_next/static/chunks/a.js" async=""></script>'),
      "out/_next/static/chunks/a.js": "console.log(1)",
    });
    expect(pass.status).toBe(0);
    expect(pass.stdout).toMatch(/Home initial JS: 0\.\d kB gzipped of 150 kB/);

    const fail = exportWith({
      "out/projects.html": page('<script src="/_next/static/chunks/b.js" async=""></script>'),
      "out/_next/static/chunks/b.js": big,
    });
    expect(fail.status).toBe(1);
    expect(fail.stderr).toMatch(/initial JS 1\d\d\.\d kB over 150 kB: out.projects\.html/);
  });

  it("does not count the legacy nomodule script", () => {
    const run = exportWith({
      "out/index.html": page('<script src="/_next/static/chunks/c.js" noModule=""></script>'),
      "out/_next/static/chunks/c.js": randomBytes(160_000).toString("latin1"),
    });
    expect(run.status).toBe(0);
  });

  it("passes pages open to search with one canonical, title and description each", () => {
    const run = exportWith(indexed);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it.each([
    ["a second canonical", { "out/projects.html": page("", seoHead("/projects", { extra: '<link rel="canonical" href="x"/>' })) }, /not one canonical: out.projects\.html/],
    ["a canonical on another host", { "out/projects.html": page("", seoHead("/projects", { canonical: "https://elsewhere.test/projects" })) }, /canonical on another host \(https:\/\/elsewhere\.test\)/],
    ["a canonical to another page", { "out/projects.html": page("", seoHead("/projects", { canonical: `${ORIGIN}/` })) }, /canonical points at \/, not the page/],
    ["no description", { "out/projects.html": page("", seoHead("/projects").replace(/<meta name="description"[^>]*>/, "")) }, /not one description: out.projects\.html/],
    ["two titles", { "out/projects.html": page("", seoHead("/projects", { extra: "<title>U</title>" })) }, /not one <title>: out.projects\.html/],
    ["a canonical on a hidden page", { "out/projects/page/2.html": page("", `${HIDDEN}<link rel="canonical" href="${ORIGIN}/projects/page/2"/>`) }, /canonical on a page kept out of search/],
    ["a hidden page in the sitemap", { "out/projects/page/2.html": page(""), "out/sitemap.xml": sitemap("/", "/projects", "/projects/page/2") }, /sitemap lists a page that is missing or kept out of search: .*\/projects\/page\/2/],
    ["/desk in the sitemap", { "out/sitemap.xml": sitemap("/", "/projects", "/desk") }, /sitemap lists a page that is missing or kept out of search: .*\/desk/],
    ["a page left out of the sitemap", { "out/sitemap.xml": sitemap("/") }, /sitemap leaves out \/projects/],
    ["no JSON-LD Person on home", { "out/index.html": page("", seoHead("/")) }, /home has not exactly one JSON-LD Person/],
    ["a 404 page open to search", { "out/404.html": page("", "<title>T</title>") }, /404 page open to search/],
    ["robots.txt without the sitemap", { "out/robots.txt": "User-Agent: *" }, /robots.txt does not name the sitemap/],
    [
      "an expired security.txt",
      { "out/.well-known/security.txt": "Contact: https://report.test\nExpires: 2020-01-01T00:00:00Z\n" },
      /security\.txt is missing, has no contact or has expired/,
    ],
  ])("fails with %s", (_, files, message) => {
    const run = exportWith({ ...indexed, ...files });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
  });
});
