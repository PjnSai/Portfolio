import { SkipLink } from "@/components/public/bits";
import { NavEnhancer } from "@/components/public/NavEnhancer";
import { Footer, SiteNav } from "@/components/public/SiteNav";
import { pageModel } from "@/lib/public/content";
import { loadSite } from "@/lib/site";
import "./site.css";

export default async function SiteLayout({ children }: LayoutProps<"/">) {
  const site = await loadSite();
  const model = pageModel(site);
  return (
    <div className="site" id="top">
      <SkipLink />
      <SiteNav name={model.name} sections={model.sections} contact={model.contact?.anchor} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer name={model.name} hasProjects={model.projects.length > 0} />
      <NavEnhancer />
    </div>
  );
}
