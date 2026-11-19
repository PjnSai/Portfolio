"use client";

import { useEffect } from "react";
import { setupMarquee } from "@/lib/public/marquee";
import { setupSectionMotion } from "@/lib/public/motion";
import { setupShowcase } from "@/lib/public/showcase";

// The home page's motion: section transitions, the project showcase and the
// skills strip. It renders nothing; without it the page is complete and static.
export function HomeEnhancer() {
  useEffect(() => {
    const cleanups = [
      setupSectionMotion(),
      ...Array.from(document.querySelectorAll<HTMLElement>("[data-showcase]"), setupShowcase),
      ...Array.from(document.querySelectorAll<HTMLElement>("[data-marquee]"), setupMarquee),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
  return null;
}
