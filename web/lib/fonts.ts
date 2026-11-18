// The three typefaces, downloaded by next/font while building and served from
// /_next/static/media with the site. Visitors' browsers never contact Google.
import { Bricolage_Grotesque, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

export const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
});

export const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans-face",
  display: "swap",
});

export const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono-face",
  display: "swap",
});

export const fontVariables = [display.variable, sans.variable, mono.variable].join(" ");
