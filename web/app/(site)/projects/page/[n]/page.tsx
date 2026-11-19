import type { Metadata } from "next";
import { ProjectPage } from "@/components/public/ProjectPages";
import { pageModel } from "@/lib/public/content";
import { listMetadata } from "@/lib/public/meta";
import { pageParams, parsePage } from "@/lib/public/pagination";
import { loadSite } from "@/lib/site";

export const dynamicParams = false;

export async function generateStaticParams() {
  const site = await loadSite();
  return pageParams(pageModel(site).projects.length);
}

export async function generateMetadata({ params }: PageProps<"/projects/page/[n]">): Promise<Metadata> {
  const site = await loadSite();
  return listMetadata(site, pageModel(site), parsePage((await params).n));
}

export default async function ProjectListPage({ params }: PageProps<"/projects/page/[n]">) {
  const page = parsePage((await params).n);
  const site = await loadSite();
  return <ProjectPage projects={pageModel(site).projects} site={site} page={page} />;
}
