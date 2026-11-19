import { SkipLink } from "@/components/public/bits";
import { DisplayEnhancer } from "@/components/public/DisplayEnhancer";
import { NavEnhancer } from "@/components/public/NavEnhancer";
import { Footer, SiteNav } from "@/components/public/SiteNav";
import { pageModel } from "@/lib/public/content";
import { defaultPalette, paletteMode, validPalettes } from "@/lib/public/tokens";
import { loadSite } from "@/lib/site";
import "./site.css";

export default async function SiteLayout({ children }: LayoutProps<"/">) {
  const site = await loadSite();
  const model = pageModel(site);
  const palettes = validPalettes(site.palettes);
  const picks = paletteMode(site.settings.palette_mode) === "pick" ? palettes : [];
  return (
    <div className="site" id="top">
      <SkipLink />
      <SiteNav
        name={model.name}
        sections={model.sections}
        contact={model.contact?.anchor}
        palettes={picks.map(({ id, name }) => ({ id, name }))}
        defaultId={defaultPalette(palettes, site.settings.default_palette_id)?.id}
      />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer name={model.name} hasProjects={model.projects.length > 0} />
      <NavEnhancer />
      <DisplayEnhancer />
    </div>
  );
}
