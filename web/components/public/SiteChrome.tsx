import type { ReactNode } from "react";
import { SkipLink } from "@/components/public/bits";
import { DisplayEnhancer } from "@/components/public/DisplayEnhancer";
import { NavEnhancer } from "@/components/public/NavEnhancer";
import { Footer, SiteNav } from "@/components/public/SiteNav";
import { pageModel } from "@/lib/public/content";
import { defaultPalette, paletteMode, validPalettes } from "@/lib/public/tokens";
import type { PublicSite } from "@/lib/site";

/** The nav, main landmark and footer every public page shares, the 404 page too. */
export function SiteChrome({ site, children }: { site: PublicSite; children: ReactNode }) {
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
