"use client";

import { useEffect } from "react";
import { API_ORIGIN } from "@/lib/api-base";
import { armLazyLoad } from "@/lib/public/lazy";
import { SITE_KEY } from "@/lib/public/turnstile-key";

// Renders nothing. It watches the contact form's markup, which is already in the
// page, and fetches the form's code, with Turnstile's script, only when the form
// is within a screen of the visible page or takes focus. Until then, and if
// the code cannot be fetched, the form cannot send: its button is off, and the
// inline boot script stops any native submit (lib/public/boot-script.ts).
export function ContactLoader() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-contact-root]");
    if (!root) return;
    const disarm = armLazyLoad(
      root,
      () => {
        import("@/components/public/ContactApp")
          .then(({ mountContact }) => {
            mountContact(root, { apiOrigin: API_ORIGIN, siteKey: SITE_KEY });
          })
          .catch(() => {
            const failed = document.querySelector<HTMLElement>("[data-contact-failed]");
            if (failed) failed.hidden = false;
          });
      },
      "IntersectionObserver" in window ? IntersectionObserver : undefined,
    );
    return () => {
      disarm();
    };
  }, []);
  return null;
}
