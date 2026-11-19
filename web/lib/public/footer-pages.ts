// The pages linked from every footer (SPEC 3.10).
import type { SeoKey } from "./meta";

export type FooterPage = { route: string; label: string; key: SeoKey; description: string };

export const FOOTER_PAGES: readonly FooterPage[] = [];
