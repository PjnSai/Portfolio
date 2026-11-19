"use client";

import { useEffect } from "react";

const MOBILE = "(max-width: 759.98px)";

/** The heading to focus for a jump target: the target itself or its first heading. */
function focusable(target: HTMLElement): HTMLElement {
  if (target.matches("h1, h2, main")) return target;
  return target.querySelector<HTMLElement>("h1, h2") ?? target;
}

// The only script on the public pages until 3B. It renders nothing: it adds the
// burger menu, marks the section in view with aria-current, and moves focus to
// the heading a jump link points at. Without it every link still works.
export function NavEnhancer() {
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>("[data-nav]");
    const menu = nav?.querySelector<HTMLElement>("nav");
    const burger = menu?.querySelector<HTMLButtonElement>("[data-burger]");
    if (!nav || !menu || !burger) return;
    nav.dataset.enhanced = "true";

    const isOpen = () => burger.getAttribute("aria-expanded") === "true";
    const setOpen = (open: boolean) => {
      burger.setAttribute("aria-expanded", String(open));
      nav.dataset.open = String(open);
    };
    setOpen(false);

    const onBurger = () => setOpen(!isOpen());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen()) {
        setOpen(false);
        burger.focus();
      }
    };
    // Tabbing out of the open menu closes it, so focus never sits in a hidden list.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (isOpen() && !(next instanceof Node && menu.contains(next))) setOpen(false);
    };
    const mobile = window.matchMedia(MOBILE);
    const onResize = () => {
      if (!mobile.matches) setOpen(false);
    };

    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link || !link.hash) return;
      const url = new URL(link.href);
      if (url.pathname !== window.location.pathname) return;
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (!target) return;
      if (nav.contains(link)) setOpen(false);
      // After the browser has scrolled to the fragment.
      requestAnimationFrame(() => focusable(target).focus({ preventScroll: true }));
    };

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-nav-link]"));
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));
    const inView = new Map<string, boolean>();
    const observer =
      "IntersectionObserver" in window && sections.length > 0
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) inView.set(entry.target.id, entry.isIntersecting);
              const current = sections.find((section) => inView.get(section.id))?.id;
              for (const link of links) {
                if (current && link.hash === `#${current}`) {
                  link.setAttribute("aria-current", "location");
                } else {
                  link.removeAttribute("aria-current");
                }
              }
            },
            { rootMargin: "-30% 0px -60% 0px" },
          )
        : null;
    for (const section of sections) observer?.observe(section);

    burger.addEventListener("click", onBurger);
    document.addEventListener("keydown", onKey);
    menu.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", onClick);
    mobile.addEventListener("change", onResize);
    return () => {
      burger.removeEventListener("click", onBurger);
      document.removeEventListener("keydown", onKey);
      menu.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", onClick);
      mobile.removeEventListener("change", onResize);
      observer?.disconnect();
      delete nav.dataset.enhanced;
    };
  }, []);
  return null;
}
