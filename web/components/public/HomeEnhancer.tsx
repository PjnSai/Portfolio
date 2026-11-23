"use client";

import { useEffect } from "react";

// The home page's motion: section transitions, the project showcase and the
// skills strip. It renders nothing; without it the page is complete and static.
// The code is fetched after hydration so it stays out of the initial bundle;
// until it runs the page shows the static versions, which it only enhances.
export function HomeEnhancer() {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let stopped = false;
    import("@/lib/public/home-motion")
      .then(({ setupHome }) => {
        if (!stopped) cleanup = setupHome();
      })
      .catch(() => {
        // A failed chunk leaves the static page, which is complete.
      });
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, []);
  return null;
}
