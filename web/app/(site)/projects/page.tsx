import type { Metadata } from "next";
import { ProjectPage } from "@/components/public/ProjectPages";
import { pageModel } from "@/lib/public/content";
import { listMetadata } from "@/lib/public/meta";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return listMetadata(site, pageModel(site), 1);
}

// Every project as a plain list, split into pages: the fallback for the
// showcase and a page to link to.
export default async function ProjectsPage() {
  const site = await loadSite();
  return <ProjectPage projects={pageModel(site).projects} site={site} page={1} />;
}
