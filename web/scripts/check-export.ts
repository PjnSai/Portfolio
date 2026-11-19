// Fails if the build produced anything that needs a server, or leaked a secret.
// Pages Functions, SSR, middleware and route handlers would all run on Workers,
// which the free plan limits; the site must be plain files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { measureRules, parseRules, routeOf } from "../lib/pages-headers.ts";
import { INITIAL_JS_BUDGET_KB, initialJsBytes } from "../lib/js-budget.ts";
import { BOOT_SCRIPT } from "../lib/public/boot-script.ts";
import { EXTRA_SCRIPT_HASHES } from "../lib/security-headers.ts";
import { siteOrigin } from "../lib/seo.ts";

const problems: string[] = [];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const required of ["out/index.html", "out/404.html", "out/_headers"]) {
  if (!existsSync(required)) problems.push(`missing ${required}`);
}

// Pages ignores a _headers file past its limits, which would drop every header.
if (existsSync("out/_headers")) {
  problems.push(...measureRules(readFileSync("out/_headers", "utf8")).problems);
}

// Every page carries the boot script exactly as written, and every policy
// allows it by hash; no page has a style attribute (the policy allows none).
const htmlFiles = walk("out").filter((file) => file.endsWith(".html") && !/[\\/]_next[\\/]/.test(file));
for (const file of htmlFiles) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(`<script>${BOOT_SCRIPT}</script>`)) problems.push(`boot script missing or changed: ${file}`);
  if (/<[^>]+\sstyle=/.test(text)) problems.push(`style attribute: ${file}`);
}
if (existsSync("out/_headers")) {
  for (const rule of parseRules(readFileSync("out/_headers", "utf8"))) {
    for (const [name, value] of rule.set) {
      if (name !== "Content-Security-Policy") continue;
      for (const hash of EXTRA_SCRIPT_HASHES) {
        if (!value.includes(`'${hash}'`)) problems.push(`policy for ${rule.path} lacks ${hash}`);
      }
    }
  }
}

// SPEC 8.2: one title on every page; a page open to search has one canonical
// on this site's origin pointing at itself, one description and preview tags,
// and is in the sitemap; a page kept out of search has no canonical and is not.
const origin = siteOrigin(process.env);
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
const indexable = new Set<string>();
for (const file of htmlFiles) {
  const name = relative("out", file).replace(/\\/g, "/");
  if (name.startsWith("_not-found")) continue;
  const text = readFileSync(file, "utf8");
  const route = routeOf(name);
  if (count(text, /<title>/g) !== 1) problems.push(`not one <title>: ${file}`);
  const hidden = /<meta name="robots" content="noindex/.test(text);
  const canonicals = [...text.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((m) => m[1]);
  if (hidden || route === null) {
    if (!hidden) problems.push(`404 page open to search: ${file}`);
    if (canonicals.length) problems.push(`canonical on a page kept out of search: ${file}`);
    continue;
  }
  if (route.startsWith("/desk")) problems.push(`admin page open to search: ${file}`);
  if (canonicals.length !== 1) problems.push(`not one canonical: ${file}`);
  if (count(text, /<meta name="description" /g) !== 1) problems.push(`not one description: ${file}`);
  for (const canonical of canonicals) {
    let url: URL | null = null;
    try {
      url = new URL(canonical);
    } catch {
      problems.push(`canonical is not a full URL: ${file}`);
    }
    if (url && url.origin !== origin) problems.push(`canonical on another host (${url.origin}): ${file}`);
    if (url && url.origin === origin && url.pathname !== route) {
      problems.push(`canonical points at ${url.pathname}, not the page: ${file}`);
    }
  }
  const ogUrl = /<meta property="og:url" content="([^"]*)"/.exec(text)?.[1];
  if (ogUrl !== canonicals[0]) problems.push(`og:url differs from the canonical: ${file}`);
  if (!/<meta property="og:image" content="[^"]+"/.test(text)) problems.push(`no og:image: ${file}`);
  if (!/<meta name="twitter:card" content="summary_large_image"/.test(text)) problems.push(`no twitter card: ${file}`);
  indexable.add(route);
}
const people = count(readFileSync("out/index.html", "utf8"), /<script type="application\/ld\+json">\{[^<]*"@type":"Person"/g);
if (indexable.has("/") && people !== 1) problems.push("home has not exactly one JSON-LD Person");

if (indexable.size > 0) {
  const sitemap = existsSync("out/sitemap.xml") ? readFileSync("out/sitemap.xml", "utf8") : "";
  if (!sitemap) problems.push("missing out/sitemap.xml");
  const listed = new Set<string>();
  for (const [, loc] of sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)) {
    const url = new URL(loc);
    if (url.origin !== origin) problems.push(`sitemap lists another host: ${loc}`);
    else if (!indexable.has(url.pathname)) problems.push(`sitemap lists a page that is missing or kept out of search: ${loc}`);
    listed.add(url.pathname);
  }
  for (const route of indexable) if (!listed.has(route)) problems.push(`sitemap leaves out ${route}`);
  const robots = existsSync("out/robots.txt") ? readFileSync("out/robots.txt", "utf8") : "";
  if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) problems.push("robots.txt does not name the sitemap");
}

// SPEC 4.6: initial JavaScript on each public page, gzipped.
const budget = INITIAL_JS_BUDGET_KB * 1000;
let homeBytes = 0;
for (const file of htmlFiles) {
  const route = file.replace(/\\/g, "/").replace(/^out\//, "");
  if (route.startsWith("desk")) continue;
  const bytes = initialJsBytes(readFileSync(file, "utf8"), (src) => {
    const path = join("out", src.split("?")[0]);
    return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  });
  if (route === "index.html") homeBytes = bytes;
  if (bytes > budget) {
    problems.push(`initial JS ${(bytes / 1000).toFixed(1)} kB over ${INITIAL_JS_BUDGET_KB} kB: ${file}`);
  }
}
console.log(`Home initial JS: ${(homeBytes / 1000).toFixed(1)} kB gzipped of ${INITIAL_JS_BUDGET_KB} kB.`);

// Server output: a standalone server, middleware, or functions for Pages.
for (const path of [".next/standalone", "out/_worker.js", "functions", "out/functions"]) {
  if (existsSync(path)) problems.push(`server output at ${path}`);
}
for (const file of walk(".next/server")) {
  if (/(^|[\\/])(middleware|proxy)\.js$/.test(file)) problems.push(`middleware: ${file}`);
}

// Prefetch files must sit where the client asks for them (flatten-segments.ts).
for (const file of walk("out")) {
  const path = file.replace(/\\/g, "/");
  if (!path.startsWith("out/_next/") && /\/__next\.[^/]*\//.test(path)) {
    problems.push(`nested prefetch file: ${file}`);
  }
}

// Source that needs a server at run time.
const SERVER_ONLY = [
  [/^\s*["']use server["']/m, "server action"],
  [/from\s+["']next\/headers["']/, "cookies() or headers()"],
  [/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/, "dynamic rendering"],
  [/\bconnection\(\)/, "dynamic rendering"],
] as const;
for (const file of walk("app").concat(walk("components"), walk("lib"))) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  if (/[\\/]route\.tsx?$/.test(file)) problems.push(`route handler: ${file}`);
  const source = readFileSync(file, "utf8");
  for (const [pattern, what] of SERVER_ONLY) {
    if (pattern.test(source)) problems.push(`${what}: ${file}`);
  }
}
for (const file of ["middleware.ts", "proxy.ts"]) {
  if (existsSync(file)) problems.push(`middleware: ${file}`);
}

// No secret value from the build environment may end up in a shipped file.
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|HOOK|_KEY$)/;
const secrets = Object.entries(process.env)
  .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
  .map(([name, value]) => [name, value as string]);
for (const file of walk("out")) {
  if (statSync(file).size > 5_000_000) continue;
  const text = readFileSync(file, "latin1");
  for (const [name, value] of secrets) {
    if (text.includes(value)) problems.push(`${name} appears in ${file}`);
  }
}

if (problems.length) {
  console.error(`Static export check failed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Static export check passed.");
