import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { BOOT_SCRIPT } from "@/lib/public/boot-script";
import { defaultPalette, paletteCss, paletteMode, validPalettes } from "@/lib/public/tokens";
import { siteOrigin } from "@/lib/seo";
import { loadSite } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: "Pujan Shahi",
};

// Every page is built ahead of time; the policy in out/_headers lists the
// hashes of each page's inline scripts and styles (see scripts/write-headers.ts),
// including the palette style below. The boot script picks the visitor's
// palette and theme before the body is parsed, so it changes attributes React
// rendered on <html>; suppressHydrationWarning covers that element only.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const site = await loadSite();
  const palettes = validPalettes(site.palettes);
  const start = defaultPalette(palettes, site.settings.default_palette_id);
  return (
    <html
      lang="en-GB"
      className={fontVariables}
      data-palette={start?.id}
      data-palette-mode={paletteMode(site.settings.palette_mode)}
      data-palettes={palettes.map((palette) => palette.id).join(" ")}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
        <style>{paletteCss(palettes)}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
