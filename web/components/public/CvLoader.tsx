"use client";

import { useEffect } from "react";
import { API_ORIGIN } from "@/lib/api-base";
import { armLazyLoad } from "@/lib/public/lazy";
import { SITE_KEY } from "@/lib/public/turnstile-key";

// Renders nothing. It watches the CV block's empty root and fetches the block's
// code only when the root is within a screen of the visible page, so the
// home page's first load carries only this. If the code cannot be fetched the
// block simply stays empty.
export function CvLoader() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-cv-root]");
    if (!root) return;
    return armLazyLoad(
      root,
      () => {
        import("@/components/public/CvApp")
          .then(({ mountCv }) => {
            mountCv(root, { apiOrigin: API_ORIGIN, siteKey: SITE_KEY });
          })
          .catch(() => undefined);
      },
      "IntersectionObserver" in window ? IntersectionObserver : undefined,
    );
  }, []);
  return null;
}
