"use client";

import { useEffect } from "react";
import { API_ORIGIN } from "@/lib/api-base";
import { armLazyLoad } from "@/lib/public/lazy";
import { SITE_KEY } from "@/lib/public/turnstile-key";

// Renders nothing. It watches the contact form's markup, which is already in the
// page, and fetches the form's code, with Turnstile's script, only when the form
// is within a screen of the visible page or takes focus. Until then, and if
// the code cannot be fetched, the form cannot send: its button is off and a
// stray submit is stopped here, so nothing typed can end up in the address.
export function ContactLoader() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-contact-root]");
    if (!root) return;
    const hold = (event: Event) => event.preventDefault();
    root.addEventListener("submit", hold);
    const disarm = armLazyLoad(
      root,
      () => {
        import("@/components/public/ContactApp")
          .then(({ mountContact }) => {
            root.removeEventListener("submit", hold);
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
      root.removeEventListener("submit", hold);
    };
  }, []);
  return null;
}
