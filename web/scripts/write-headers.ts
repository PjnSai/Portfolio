// Runs after `next build`: writes out/_headers for Cloudflare Pages, with each
// page's own Content-Security-Policy (hashes of that page's inline scripts).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { apiOrigin } from "../lib/api-base.ts";
import {
  buildRules,
  measureRules,
  type Page,
  routeOf,
  writeRules,
} from "../lib/pages-headers.ts";

const OUT = "out";

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_next" ? [] : htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

const pages: Page[] = [];
let notFound: Page | undefined;
for (const file of htmlFiles(OUT)) {
  const name = relative(OUT, file);
  // Next writes the not-found page twice; Pages serves 404.html.
  if (name.replace(/\\/g, "/").startsWith("_not-found")) continue;
  const page = { route: routeOf(name) ?? "", html: readFileSync(file, "utf8") };
  if (routeOf(name) === null) notFound = page;
  else pages.push(page);
}
if (!notFound) throw new Error("out/404.html is missing.");

const text = writeRules(buildRules(pages, notFound, apiOrigin(process.env.API_BASE_URL)));
writeFileSync(join(OUT, "_headers"), text);
const { rules, longest } = measureRules(text);
console.log(`_headers: ${rules} rules for ${pages.length + 1} pages, longest line ${longest}`);
