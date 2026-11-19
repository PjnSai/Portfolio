// Everything the home page's motion needs, in one module so HomeEnhancer can
// load it as one chunk after first paint.
import { setupMarquee } from "./marquee";
import { setupSectionMotion } from "./motion";
import { setupShowcase } from "./showcase";

export function setupHome(doc: Document = document): () => void {
  const cleanups = [
    setupSectionMotion(doc),
    ...Array.from(doc.querySelectorAll<HTMLElement>("[data-showcase]"), setupShowcase),
    ...Array.from(doc.querySelectorAll<HTMLElement>("[data-marquee]"), setupMarquee),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
