import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADMIN_STYLE_HASHES } from "@/lib/security-headers";
import {
  buildRules,
  GROUP_AT,
  groupPages,
  headersFor,
  MAX_LINE,
  MAX_RULES,
  measureRules,
  parseRules,
  routeOf,
  writeRules,
} from "@/lib/pages-headers";

const API = "https://api.portfolio.test";
const sha = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

const home = {
  route: "/",
  html: '<html><head><script src="/_next/a.js"></script></head><body><script>self.a=1</script></body></html>',
};
const desk = { route: "/desk/media", html: "<script>self.b=2</script><style>p{}</style>" };
const notFound = { route: "", html: "<script>self.c=3</script>" };

function served(path: string) {
  return headersFor(parseRules(writeRules(buildRules([home, desk], notFound, API))), path);
}

describe("routeOf", () => {
  it.each([
    ["index.html", "/"],
    ["desk.html", "/desk"],
    ["desk/sections.html", "/desk/sections"],
    ["desk\\sections\\edit.html", "/desk/sections/edit"],
    ["projects/index.html", "/projects"],
  ])("%s is served at %s", (file, route) => {
    expect(routeOf(file)).toBe(route);
  });

  it("knows the 404 page", () => {
    expect(routeOf("404.html")).toBeNull();
  });
});

describe("_headers for a build", () => {
  it("gives each page one policy listing the hashes of its own inline code", () => {
    const policy = served("/").get("content-security-policy") ?? "";

    expect(policy).toContain(`'${sha("self.a=1")}'`);
    expect(policy).not.toContain(sha("self.b=2"));
    expect(policy).not.toContain(sha("self.c=3"));
    expect(policy).not.toContain(", ");
  });

  it("hashes inline styles too, and lets admin pages call the API", () => {
    const policy = served("/desk/media").get("content-security-policy") ?? "";

    expect(policy).toContain(`script-src 'self' '${sha("self.b=2")}'`);
    const styles = /style-src ([^;]*)/.exec(policy)?.[1].split(" ") ?? [];
    expect(styles).toEqual(
      ["'self'", ...[sha("p{}"), ...ADMIN_STYLE_HASHES].sort().map((h) => `'${h}'`)],
    );
    expect(policy).toContain(`connect-src 'self' ${API}`);
  });

  it("gives unknown paths the 404 page's policy and every static header", () => {
    const headers = served("/no-such-page");

    expect(headers.get("content-security-policy")).toContain(sha("self.c=3"));
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(headers.get("x-robots-tag")).toBeNull();
  });

  it("keeps admin pages out of search engines and caches", () => {
    for (const path of ["/desk", "/desk/media", "/desk/sections/edit"]) {
      expect(served(path).get("x-robots-tag")).toBe("noindex, nofollow");
      expect(served(path).get("cache-control")).toBe("no-store");
    }
    expect(served("/").get("cache-control")).toBeNull();
  });

  it("lets built assets be cached for good", () => {
    expect(served("/_next/static/chunks/a.js").get("cache-control")).toContain("immutable");
  });

  it("refuses more rules or longer lines than Pages accepts", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ route: `/p${i}`, html: "" }));
    expect(() => writeRules(buildRules(many, notFound, API))).toThrow(/rules/);

    const scripts = Array.from({ length: 60 }, (_, i) => `<script>self.x=${i}</script>`).join("");
    const long = { route: "/long", html: scripts };
    expect(MAX_LINE).toBe(2000);
    expect(() => writeRules(buildRules([long], notFound, API))).toThrow(/2000/);
  });
});

describe("many pages", () => {
  const projects = Array.from({ length: 120 }, (_, i) => ({
    route: `/projects/p${i}`,
    html: `<script>self.p=${i % 5}</script>`,
  }));
  const pages = [home, desk, { route: "/projects", html: "<script>self.list=1</script>" }, ...projects];
  const text = writeRules(buildRules(pages, notFound, API));
  const rules = parseRules(text);

  it("keeps one rule per page while they fit", () => {
    expect(groupPages([home, desk], notFound).map(([path]) => path)).toEqual(["/", "/desk/media"]);
  });

  it("folds a route pattern into one rule holding its pages' hashes and the 404 page's", () => {
    expect(rules.map((rule) => rule.path)).toContain("/projects/*");
    expect(rules.some((rule) => rule.path === "/projects/p7")).toBe(false);
    const policy = headersFor(rules, "/projects/p7").get("content-security-policy") ?? "";
    expect(policy).toContain(sha("self.p=2"));
    expect(policy).toContain(sha("self.p=3"));
    expect(policy).toContain(sha("self.c=3"));
    expect(policy).not.toContain(sha("self.a=1"));
    expect(policy).not.toContain(`connect-src 'self' ${API}`);
    expect(policy.match(/script-src/g)).toHaveLength(1);
  });

  it("keeps exact rules for pages outside the folded pattern", () => {
    const policy = headersFor(rules, "/projects").get("content-security-policy") ?? "";
    expect(policy).toContain(sha("self.list=1"));
    expect(policy).not.toContain(sha("self.p=2"));
    expect(headersFor(rules, "/desk/media").get("content-security-policy")).toContain(sha("self.b=2"));
  });

  it("stays within the limits Pages accepts", () => {
    expect(measureRules(text).problems).toEqual([]);
    expect(groupPages(pages, notFound).length).toBeLessThanOrEqual(GROUP_AT);
  });

  it("reports a file past either limit", () => {
    const tooMany = Array.from({ length: MAX_RULES + 1 }, (_, i) => `/p${i}\n  X-Test: a`).join("\n");
    expect(measureRules(tooMany).problems.join()).toMatch(/101 rules/);
    expect(measureRules(`/*\n  X-Test: ${"a".repeat(MAX_LINE)}\n`).problems.join()).toMatch(/2000/);
  });
});

describe("reading _headers", () => {
  it("removes a header an earlier rule set when a later rule says so", () => {
    const rules = parseRules("/*\n  X-Test: a\n/page\n  ! X-Test\n  X-Test: b\n");

    expect(headersFor(rules, "/page").get("x-test")).toBe("b");
    expect(headersFor(rules, "/other").get("x-test")).toBe("a");
  });

  it("matches a splat only where it is written", () => {
    const rules = parseRules("/desk/*\n  X-Test: a\n");

    expect(headersFor(rules, "/desk/x").get("x-test")).toBe("a");
    expect(headersFor(rules, "/desktop").get("x-test")).toBeNull();
    expect(headersFor(rules, "/a/desk/x").get("x-test")).toBeNull();
  });
});
