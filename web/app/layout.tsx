import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { defaultPalette, paletteCss, validPalettes } from "@/lib/public/tokens";
import { loadSite } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pujan Shahi",
};

// Every page is built ahead of time; the policy in out/_headers lists the
// hashes of each page's inline scripts and styles (see scripts/write-headers.ts),
// including the palette style below.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const site = await loadSite();
  const palettes = validPalettes(site.palettes);
  const start = defaultPalette(palettes, site.settings.default_palette_id);
  return (
    <html lang="en-GB" className={fontVariables} data-palette={start?.id}>
      <head>
        <style>{paletteCss(palettes)}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
