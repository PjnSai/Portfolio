"use client";

import { useEffect } from "react";

// Renders nothing. It adds the theme menu's behaviour, after the page is up:
// the menu is in the page from the start, hidden and holding its place, and
// is shown once this has run. The code is fetched after hydration so it stays
// out of the initial bundle; without it the page is complete and the
// palette and theme the visitor chose earlier still apply (the inline script).
export function DisplayEnhancer() {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let stopped = false;
    import("@/lib/public/display-menu")
      .then(({ setupDisplayMenu }) => {
        if (!stopped) cleanup = setupDisplayMenu();
      })
      .catch(() => {
        // A failed chunk leaves the menu hidden; the page itself is complete.
      });
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, []);
  return null;
}
