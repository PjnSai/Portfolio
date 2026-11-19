import type { Metadata } from "next";
import { ProjectPage } from "@/components/public/ProjectPages";
import { pageModel } from "@/lib/public/content";
import { pageCount, pageHref } from "@/lib/public/pagination";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  const model = pageModel(site);
  const pages = pageCount(model.projects.length);
  return {
    title: `Projects | ${model.name}`,
    alternates: { canonical: pageHref(1) },
    ...(model.projects.length === 0 ? { robots: { index: false, follow: false } } : {}),
    ...(pages > 1 ? { pagination: { next: pageHref(2) } } : {}),
  };
}

// Every project as a plain list, split into pages: the fallback for the
// showcase and a page to link to.
export default async function ProjectsPage() {
  const site = await loadSite();
  return <ProjectPage projects={pageModel(site).projects} site={site} page={1} />;
}
