// The pages linked from every footer (SPEC 3.10). Their words are in
// components/public/FooterPages.tsx.
import type { SeoKey } from "./meta";

export type FooterPage = { route: string; label: string; key: SeoKey; description: string };

export const FOOTER_PAGES: readonly FooterPage[] = [
  {
    route: "/privacy",
    label: "Privacy",
    key: "privacy",
    description: "What this site keeps about visitors, why, and for how long.",
  },
  {
    route: "/accessibility",
    label: "Accessibility",
    key: "accessibility",
    description: "How this site is built to be usable by everyone, what is known not to work, and how to report a problem.",
  },
  {
    route: "/security",
    label: "Security",
    key: "security",
    description: "How this site is protected and how to report a security problem.",
  },
  {
    route: "/how-this-site-is-built",
    label: "How this site is built",
    key: "how_built",
    description: "The parts of this site, where each one runs, and how a change reaches the live site.",
  },
];
