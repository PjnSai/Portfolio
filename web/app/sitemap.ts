import type { MetadataRoute } from "next";
import { pageModel } from "@/lib/public/content";
import { FOOTER_PAGES } from "@/lib/public/footer-pages";
import { listRoutes } from "@/lib/public/pagination";
import { absoluteUrl, sitemapRoutes } from "@/lib/seo";
import { loadSite } from "@/lib/site";

export const dynamic = "force-static";

// Only pages that exist and may be indexed: never /desk, the 404 page or the
// list page built past the end.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = await loadSite();
  const model = pageModel(site);
  return sitemapRoutes({
    hasContent: site.sections.length > 0,
    listRoutes: listRoutes(model.projects.length),
    projectSlugs: model.projects.map((project) => project.slug),
    footerRoutes: FOOTER_PAGES.map((page) => page.route),
  }).map((route) => ({ url: absoluteUrl(route) }));
}
