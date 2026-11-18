// Writing and reading a Cloudflare Pages _headers file. Pages applies every
// rule whose path matches, in file order; "! Name" removes a header an earlier
// rule set. scripts/serve-static.ts applies the same rules, so the browser
// tests see the headers Pages will send.
// Relative imports only: the build scripts load this file with Node directly.

import { createHash } from "node:crypto";
import {
  ADMIN_PATH,
  ASSET_CACHE,
  contentSecurityPolicy,
  isPrivatePath,
  PRIVATE_HEADERS,
  STATIC_HEADERS,
} from "./security-headers.ts";

/** Pages limits for _headers. */
export const MAX_RULES = 100;
export const MAX_LINE = 2000;

export type Rule = { path: string; set: [string, string][]; unset: string[] };
export type Page = { route: string; html: string };

const SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
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

export function policyFor(page: Page, api: string): string {
  return contentSecurityPolicy({
    scripts: hashes(page.html, SCRIPT),
    styles: hashes(page.html, STYLE),
    api,
    admin: isPrivatePath(page.route),
  });
}

/** The route Pages serves an exported HTML file at, or null for the 404 page. */
export function routeOf(file: string): string | null {
  const path = file.replace(/\\/g, "/").replace(/\.html$/, "");
  if (path === "404") return null;
  if (path === "index") return "/";
  return `/${path.replace(/\/index$/, "")}`;
}

/**
 * The rules for a build. Every response gets the static headers and the 404
 * page's policy; each page then swaps that policy for its own.
 */
export function buildRules(pages: Page[], notFound: Page, api: string): Rule[] {
  const rules: Rule[] = [
    {
      path: "/*",
      set: [
        ...Object.entries(STATIC_HEADERS),
        ["Content-Security-Policy", policyFor(notFound, api)],
      ],
      unset: [],
    },
    { path: "/_next/static/*", set: [["Cache-Control", ASSET_CACHE]], unset: [] },
  ];
  for (const page of [...pages].sort((a, b) => a.route.localeCompare(b.route))) {
    rules.push({
      path: page.route,
      set: [["Content-Security-Policy", policyFor(page, api)]],
      unset: ["Content-Security-Policy"],
    });
  }
  for (const path of [ADMIN_PATH, `${ADMIN_PATH}/*`]) {
    rules.push({ path, set: Object.entries(PRIVATE_HEADERS), unset: [] });
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
