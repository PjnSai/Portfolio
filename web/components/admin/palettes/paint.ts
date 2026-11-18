"use client";

import { useCallback, useEffect, useRef } from "react";
import { HEX } from "@/lib/admin/contrast";
import { SLOTS, type Slots } from "@/lib/palettes";

/**
 * Sets CSS custom properties on an element from JS (CSSOM), so the admin
 * never needs style attributes in its HTML and the CSP stays strict.
 * Values that are not #RRGGBB are left out.
 */
export function usePaint<T extends HTMLElement>(vars: Record<string, string>) {
  const ref = useRef<T | null>(null);
  const key = JSON.stringify(vars);
  const apply = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    for (const [name, value] of Object.entries(JSON.parse(key) as Record<string, string>)) {
      if (HEX.test(value)) element.style.setProperty(name, value);
    }
  }, [key]);
  useEffect(apply, [apply]);
  return useCallback(
    (element: T | null) => {
      ref.current = element;
      apply();
    },
    [apply],
  );
}

/** --p-bg, --p-ink and so on, one per slot. */
export function slotVars(colours: Slots): Record<string, string> {
  return Object.fromEntries(SLOTS.map((slot) => [`--p-${slot.replace(/_/g, "-")}`, colours[slot]]));
}
