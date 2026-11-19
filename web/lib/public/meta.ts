// Titles, descriptions, canonicals, link previews and structured data for the
// public pages, from the owner's content with plain fallbacks.

import type { Metadata } from "next";
import { apiOrigin } from "../api-base";
import { safeHref } from "../markdown";
import { absoluteUrl, firstText, trimText } from "../seo";
import type { PublicSite } from "../site";
import type { PageModel, ProjectEntry } from "./content";
import { FOOTER_PAGES } from "./footer-pages";
import { pageHref, pageInfo } from "./pagination";

/** The one preview image: a flat card with the site's name (public/og-default.png). */
export const OG_IMAGE = { path: "/og-default.png", width: 1200, height: 630 } as const;

export type SeoKey = "home" | "projects" | "privacy" | "security" | "how_built" | "accessibility";

/** The owner's title and description for a page, from settings.seo, if any. */
export function ownerSeo(site: PublicSite, key: SeoKey): { title: string; description: string } {
  const seo = site.settings.seo as Record<string, { title?: unknown; description?: unknown }> | undefined;
  const entry = seo?.[key];
  return { title: firstText(entry?.title), description: firstText(entry?.description) };
}

type PageInput = {
  path: string;
  title: string;
  description: string;
  siteName: string;
  type?: "website" | "article";
};

export function pageMetadata({ path, title, description, siteName, type = "website" }: PageInput): Metadata {
  const url = absoluteUrl(path);
  const text = trimText(description);
  const image = absoluteUrl(OG_IMAGE.path);
  return {
    title: { absolute: title },
    description: text,
    alternates: { canonical: url },
    openGraph: {
      type,
      url,
      title,
      description: text,
      siteName,
      locale: "en_GB",
      images: [{ url: image, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: siteName }],
    },
    twitter: { card: "summary_large_image", title, description: text, images: [image] },
  };
}

/** A page that exists but must stay out of search: no canonical, no preview tags. */
export function hiddenMetadata(title: string): Metadata {
  return { title: { absolute: title }, robots: { index: false, follow: false } };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function homeMetadata(site: PublicSite, model: PageModel): Metadata {
  const owner = ownerSeo(site, "home");
  const role = firstText(model.hero?.role);
  return pageMetadata({
    path: "/",
    title: owner.title || (role ? `${model.name} | ${role}` : model.name),
    description:
      owner.description ||
      firstText(site.settings.description, model.hero?.body) ||
      `${model.name}: projects, experience and skills.`,
    siteName: model.name,
  });
}

export function projectMetadata(model: PageModel, project: ProjectEntry): Metadata {
  return pageMetadata({
    path: `/projects/${project.slug}`,
    title: `${project.data.title} | ${model.name}`,
    description: firstText(project.data.summary) || `${project.data.title}, a project by ${model.name}.`,
    siteName: model.name,
    type: "article",
  });
}

function photoUrl(site: PublicSite, model: PageModel): string | undefined {
  const media = model.photo?.media ? site.media[model.photo.media] : undefined;
  const largest = media?.sources.reduce((a, b) => (b.width > a.width ? b : a), media.sources[0]);
  const origin = apiOrigin(process.env.API_BASE_URL);
  return largest && origin ? `${origin}${largest.url}` : undefined;
}

/** schema.org Person for the owner, on the home page (SPEC 8.2). */
export function personData(site: PublicSite, model: PageModel): Record<string, unknown> {
  const sameAs = model.links.map((link) => safeHref(link.url)).filter((url): url is string => !!url?.startsWith("https:"));
  const role = firstText(model.hero?.role);
  const image = photoUrl(site, model);
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: model.name,
    url: absoluteUrl("/"),
    ...(role ? { jobTitle: role } : {}),
    ...(image ? { image } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

/** schema.org CreativeWork for a case-study page (SPEC 8.2). */
export function projectData(model: PageModel, project: ProjectEntry): Record<string, unknown> {
  const data = project.data;
  const description = firstText(data.summary);
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: data.title,
    url: absoluteUrl(`/projects/${project.slug}`),
    author: { "@type": "Person", name: model.name, url: absoluteUrl("/") },
    ...(description ? { description: trimText(description, 300) } : {}),
    ...(/^\d{4}-\d{2}$/.test(text(data.created)) ? { dateCreated: data.created } : {}),
    ...(data.tags.length ? { keywords: data.tags.join(", ") } : {}),
  };
}

/** /projects and /projects/page/n. The page built past the end, and the list
    before any project is published, stay out of search. */
export function listMetadata(site: PublicSite, model: PageModel, page: number): Metadata {
  const info = pageInfo(model.projects.length, page);
  const base = `Projects | ${model.name}`;
  if (model.projects.length === 0 || info.outOfRange) return hiddenMetadata(base);
  const owner = ownerSeo(site, "projects");
  const title = page > 1 ? `Projects, page ${page} | ${model.name}` : owner.title || base;
  const description = owner.description || `Projects by ${model.name}.`;
  return {
    ...pageMetadata({
      path: pageHref(page),
      title,
      description: page > 1 ? `${description} Page ${page} of ${info.pages}.` : description,
      siteName: model.name,
    }),
    pagination: { previous: info.prev && absoluteUrl(info.prev), next: info.next && absoluteUrl(info.next) },
  };
}

/** A footer page: the owner's SEO words if set, otherwise the page's own. */
export function footerMetadata(site: PublicSite, model: PageModel, route: string): Metadata {
  const page = FOOTER_PAGES.find((entry) => entry.route === route);
  if (!page) throw new Error(`Not a footer page: ${route}`);
  const owner = ownerSeo(site, page.key);
  return pageMetadata({
    path: page.route,
    title: owner.title || `${page.label} | ${model.name}`,
    description: owner.description || page.description,
    siteName: model.name,
  });
}
