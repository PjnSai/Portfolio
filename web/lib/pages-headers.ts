// Writing and reading a Cloudflare Pages _headers file. Pages applies every
// rule whose path matches, in file order; "! Name" removes a header an earlier
// rule set. scripts/serve-static.ts applies the same rules, so the browser
// tests see the headers Pages will send.
// Relative imports only: the build scripts load this file with Node directly.

import { createHash } from "node:crypto";
import {
  ADMIN_PATH,
  ASSET_CACHE,
  CONTACT_FORM_MARKER,
  contentSecurityPolicy,
  isPrivatePath,
  PAGE_CACHE,
  PRIVATE_HEADERS,
  STATIC_HEADERS,
} from "./security-headers.ts";

/** Pages limits for _headers. */
export const MAX_RULES = 100;
export const MAX_LINE = 2000;

export type Rule = { path: string; set: [string, string][]; unset: string[] };
export type Page = { route: string; html: string };

// Inline scripts the browser runs. A JSON-LD block is data, which the policy
// does not cover, so it needs no hash.
const SCRIPT = /<script(?![^>]*\ssrc=)(?![^>]*\stype="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/gi;
const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/gi;

function hashes(html: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(pattern)) {
    if (match[1] === "") continue;
    const digest = createHash("sha256").update(match[1], "utf8").digest("base64");
    found.add(`sha256-${digest}`);
  }
  return [...found];
}

/** Only the home page can hold the contact form, and only if it was built with it. */
export function hasContactForm(page: Page): boolean {
  return page.route === "/" && page.html.includes(CONTACT_FORM_MARKER);
}

function policyOf(pages: Page[], api: string, admin: boolean): string {
  return contentSecurityPolicy({
    scripts: [...new Set(pages.flatMap((page) => hashes(page.html, SCRIPT)))],
    styles: [...new Set(pages.flatMap((page) => hashes(page.html, STYLE)))],
    api,
    admin,
    form: pages.some(hasContactForm),
  });
}

export function policyFor(page: Page, api: string): string {
  return policyOf([page], api, isPrivatePath(page.route));
}

/** The route Pages serves an exported HTML file at, or null for the 404 page. */
export function routeOf(file: string): string | null {
  const path = file.replace(/\\/g, "/").replace(/\.html$/, "");
  if (path === "404") return null;
  if (path === "index") return "/";
  return `/${path.replace(/\/index$/, "")}`;
}

/** Page rules above this many are folded into one rule per route pattern. */
export const GROUP_AT = 90;

/** "/projects/*" for "/projects/a" or "/projects/a/b"; null for "/" or "/projects". */
function patternOf(route: string): string | null {
  const parts = route.split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts[0]}/*` : null;
}

/**
 * Which pages share a rule. Each page has its own rule, so its policy lists
 * only its own hashes, until that would pass `limit` rules. Then the patterns
 * with most pages are folded first, each into one rule holding the union of
 * its pages' hashes and the 404 page's (Pages serves the 404 page for an
 * unknown path under the pattern).
 */
export function groupPages(pages: Page[], notFound: Page, limit = GROUP_AT): [string, Page[]][] {
  const byPattern = new Map<string, Page[]>();
  for (const page of pages) {
    const pattern = patternOf(page.route);
    if (pattern) byPattern.set(pattern, [...(byPattern.get(pattern) ?? []), page]);
  }
  const largest = [...byPattern].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const folded = new Set<string>();
  let count = pages.length;
  for (const [pattern, members] of largest) {
    if (count <= limit || members.length < 2) break;
    folded.add(pattern);
    count -= members.length - 1;
  }
  const groups: [string, Page[]][] = [];
  for (const page of pages) {
    const pattern = patternOf(page.route);
    if (!pattern || !folded.has(pattern)) groups.push([page.route, [page]]);
  }
  for (const pattern of folded) groups.push([pattern, [...byPattern.get(pattern)!, notFound]]);
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * The rules for a build. Every response gets the static headers and the 404
 * page's policy; each page, or each folded pattern, then swaps that policy
 * for its own.
 */
export function buildRules(pages: Page[], notFound: Page, api: string): Rule[] {
  const rules: Rule[] = [
    {
      path: "/*",
      set: [
        ...Object.entries(STATIC_HEADERS),
        ["Cache-Control", PAGE_CACHE],
        ["Content-Security-Policy", policyFor(notFound, api)],
      ],
      unset: [],
    },
    {
      path: "/_next/static/*",
      set: [["Cache-Control", ASSET_CACHE]],
      unset: ["Cache-Control"],
    },
  ];
  for (const [path, members] of groupPages(pages, notFound)) {
    rules.push({
      path,
      set: [["Content-Security-Policy", policyOf(members, api, isPrivatePath(path))]],
      unset: ["Content-Security-Policy"],
    });
  }
  for (const path of [ADMIN_PATH, `${ADMIN_PATH}/*`]) {
    rules.push({ path, set: Object.entries(PRIVATE_HEADERS), unset: ["Cache-Control"] });
  }
  return rules;
}

export function writeRules(rules: Rule[]): string {
  if (rules.length > MAX_RULES) {
    throw new Error(`_headers has ${rules.length} rules; Pages allows ${MAX_RULES}.`);
  }
  const lines = rules.flatMap((rule) => [
    rule.path,
    ...rule.unset.map((name) => `  ! ${name}`),
    ...rule.set.map(([name, value]) => `  ${name}: ${value}`),
  ]);
  const long = lines.find((line) => line.length > MAX_LINE);
  if (long) {
    throw new Error(`_headers line over ${MAX_LINE} characters: ${long.slice(0, 80)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ path: line, set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) throw new Error("_headers: header before any path.");
    if (line.startsWith("!")) {
      rule.unset.push(line.slice(1).trim());
    } else {
      const colon = line.indexOf(":");
      rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

/** Rule count and longest line of a _headers file, and what breaks Pages' limits. */
export function measureRules(text: string): { rules: number; longest: number; problems: string[] } {
  const rules = parseRules(text).length;
  const longest = Math.max(0, ...text.split(/\r?\n/).map((line) => line.length));
  const problems: string[] = [];
  if (rules > MAX_RULES) problems.push(`_headers has ${rules} rules; Pages allows ${MAX_RULES}`);
  if (longest > MAX_LINE) {
    problems.push(`_headers has a line of ${longest} characters; Pages allows ${MAX_LINE}`);
  }
  return { rules, longest, problems };
}

function matches(pattern: string, path: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(path);
}

/** The headers Pages sends for a path. */
export function headersFor(rules: Rule[], path: string): Headers {
  const headers = new Headers();
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) headers.append(name, value);
  }
  return headers;
}
