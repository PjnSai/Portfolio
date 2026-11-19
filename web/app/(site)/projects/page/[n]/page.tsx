import type { Metadata } from "next";
import { ProjectPage } from "@/components/public/ProjectPages";
import { pageModel } from "@/lib/public/content";
import { pageHref, pageInfo, pageParams, parsePage } from "@/lib/public/pagination";
import { loadSite } from "@/lib/site";

export const dynamicParams = false;

export async function generateStaticParams() {
  const site = await loadSite();
  return pageParams(pageModel(site).projects.length);
}

export async function generateMetadata({ params }: PageProps<"/projects/page/[n]">): Promise<Metadata> {
  const page = parsePage((await params).n);
  const site = await loadSite();
  const model = pageModel(site);
  const info = pageInfo(model.projects.length, page);
  if (info.outOfRange) {
    return { title: `Projects | ${model.name}`, robots: { index: false, follow: false } };
  }
  return {
    title: `Projects, page ${page} | ${model.name}`,
    alternates: { canonical: pageHref(page) },
    pagination: { previous: info.prev, next: info.next },
  };
}

export default async function ProjectListPage({ params }: PageProps<"/projects/page/[n]">) {
  const page = parsePage((await params).n);
  const site = await loadSite();
  return <ProjectPage projects={pageModel(site).projects} site={site} page={page} />;
}
