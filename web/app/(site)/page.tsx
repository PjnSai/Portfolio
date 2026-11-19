import type { Metadata } from "next";
import { HomeEnhancer } from "@/components/public/HomeEnhancer";
import { Hero, SectionBlock, SkillsStrip } from "@/components/public/Sections";
import { SectionPager } from "@/components/public/SiteNav";
import { pageModel } from "@/lib/public/content";
import { loadSite } from "@/lib/site";

// Built from the published site at build time.
// With nothing published the home page is a placeholder and stays out of search.
export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return site.sections.length === 0 ? { robots: { index: false, follow: false } } : {};
}

export default async function Home() {
  const site = await loadSite();
  if (site.sections.length === 0) {
    return (
      <div className="wrap placeholder-page">
        <h1>{site.settings.title || "Portfolio"}</h1>
        <p>Site coming soon</p>
      </div>
    );
  }
  const model = pageModel(site);
  return (
    <>
      <Hero site={site} model={model} />
      <SkillsStrip site={site} />
      {model.sections.map((entry) => (
        <SectionBlock key={entry.anchor} entry={entry} site={site} model={model} />
      ))}
      <SectionPager sections={model.sections} />
      <HomeEnhancer />
    </>
  );
}
