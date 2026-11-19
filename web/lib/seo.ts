// The public address of the site and the tags search engines and link
// previews read. SITE_ORIGIN is fixed at build time; next.config.ts checks it
// before anything is built. Relative imports only: build scripts load this file.

/** Used by local and test builds that do not set SITE_ORIGIN. */
export const LOCAL_SITE_ORIGIN = "http://localhost:3000";

/** Room for search results; longer descriptions are cut at a word. */
export const DESCRIPTION_LENGTH = 155;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The origin from SITE_ORIGIN. A Pages build must set it, to an https origin
 * with no path; any other build may leave it out and gets LOCAL_SITE_ORIGIN.
 */
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SITE_ORIGIN?.trim();
  if (!raw) {
    if (env.CF_PAGES) {
      throw new Error(
        "SITE_ORIGIN is not set. A Pages build needs the public address of the site, for example https://example.com.",
      );
    }
    return LOCAL_SITE_ORIGIN;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_ORIGIN is not a URL: ${raw}`);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new Error("SITE_ORIGIN must be https (or http://localhost for local builds).");
  }
  if (env.CF_PAGES && local) throw new Error("SITE_ORIGIN for a Pages build cannot be localhost.");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SITE_ORIGIN must be an origin with no path, for example https://example.com.");
  }
  return url.origin;
}

/** An absolute URL on the site for a path such as "/projects". */
export function absoluteUrl(path: string, origin: string = siteOrigin()): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`Not a site path: ${path}`);
  return path === "/" ? `${origin}/` : `${origin}${path}`;
}

/** Markdown as one line of plain text: links keep their words, marks go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text cut to `max` characters at a word, with an ellipsis if anything was cut. */
export function trimText(text: string, max = DESCRIPTION_LENGTH): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/** The first of the given texts that is real content: not empty and not a TODO marker. */
export function firstText(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const text = plainText(value);
    if (text && !/^TODO\b/i.test(text)) return text;
  }
  return "";
}

/** JSON for a <script type="application/ld+json"> block: nothing in it can end the element. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(String.fromCharCode(0x2028))
    .join("\\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\\u2029");
}

export type SitemapInput = {
  /** False before anything is published: home is then a placeholder kept out of search. */
  hasContent: boolean;
  listRoutes: readonly string[];
  projectSlugs: readonly string[];
  footerRoutes: readonly string[];
};

/** The paths the sitemap lists: only pages that exist and may be indexed. */
export function sitemapRoutes(input: SitemapInput): string[] {
  if (!input.hasContent) return [...input.footerRoutes];
  return [
    "/",
    ...(input.projectSlugs.length ? input.listRoutes : []),
    ...input.projectSlugs.map((slug) => `/projects/${slug}`),
    ...input.footerRoutes,
  ];
}

// SPEC 8.5: search engines are welcome; AI training crawlers and bulk
// scrapers are asked to stay away. This is a request, not enforcement:
// Cloudflare's bot protection and rate limits do the enforcing.
export const BLOCKED_AGENTS: readonly string[] = [
  "GPTBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "PerplexityBot",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "Diffbot",
  "ImagesiftBot",
  "Omgilibot",
  "AhrefsBot",
  "SemrushBot",
  "MJ12bot",
  "DotBot",
];

export const REPOSITORY = "https://github.com/PjnSai/Portfolio";
/** GitHub's private vulnerability report form for the repository. */
export const REPORT_URL = `${REPOSITORY}/security/advisories/new`;
/** RFC 9116 asks for an expiry under a year away; each build moves it on. */
const SECURITY_TXT_DAYS = 180;

/** /.well-known/security.txt (RFC 9116). */
export function securityTxt(origin: string, now: Date = new Date()): string {
  const expires = new Date(now.getTime() + SECURITY_TXT_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: ${REPORT_URL}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en",
    `Canonical: ${origin}/.well-known/security.txt`,
    `Policy: ${origin}/security`,
    "",
  ].join("\n");
}
