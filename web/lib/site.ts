// The public site's content, read once at build time from GET /api/v1/site.
// Nothing here runs in the browser and no secret is needed: the document is public.
//
// Fail static: if the API cannot be read, the build fails and Cloudflare Pages
// keeps serving the last good build. Only a build with no API_BASE_URL (local
// work, CI checks), or one that says SKIP_SITE_FETCH=1 (a container image built
// before its API runs), renders without content, and never on Pages itself.

import { apiOrigin } from "./api-base";

export type Source = { width: number; height: number; url: string };
export type SiteMedia = { width: number; height: number; sources: Source[] };
export type SiteSection = { type?: string; title: string; [field: string]: unknown };
export type PublicSite = {
  settings: { title?: string; description?: string; [field: string]: unknown };
  sections: SiteSection[];
  media: Record<string, SiteMedia>;
};

export const EMPTY_SITE: PublicSite = { settings: {}, sections: [], media: {} };

const TIMEOUT_MS = 15_000;

export async function loadSite(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<PublicSite> {
  const origin = apiOrigin(env.API_BASE_URL);
  if (!origin || env.SKIP_SITE_FETCH === "1") {
    if (env.CF_PAGES) throw new Error("A Pages build must read the site from API_BASE_URL.");
    return EMPTY_SITE;
  }
  const response = await fetcher(`${origin}/api/v1/site`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "force-cache",
  });
  if (!response.ok) throw new Error(`GET /api/v1/site answered ${response.status}.`);
  const site = (await response.json()) as Partial<PublicSite>;
  if (!Array.isArray(site.sections) || typeof site.media !== "object" || !site.media) {
    throw new Error("GET /api/v1/site did not return a site document.");
  }
  // An empty answer is never published: it would replace the live site with a blank one.
  if (site.sections.length === 0) {
    throw new Error("GET /api/v1/site has no published sections.");
  }
  return { settings: site.settings ?? {}, sections: site.sections, media: site.media };
}

/** An image's sources as a srcset, with the API origin in front of each path. */
export function srcset(item: SiteMedia, origin: string): string {
  return item.sources.map((s) => `${origin}${s.url} ${s.width}w`).join(", ");
}
