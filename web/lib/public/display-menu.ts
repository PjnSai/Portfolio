// The theme menu's behaviour. Fetched after the page is up (DisplayEnhancer), so
// it is not part of the code the page needs to first paint.

import { KEYS, THEMES } from "@/lib/public/boot-script";

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is off: the choice still applies to this page.
  }
}

/**
 * Shows the theme menu and applies a choice at once. The inline script has
 * already set data-palette and data-theme on <html>; this only reflects them
 * in the radios and changes them when the visitor does. Returns what undoes it.
 */
export function setupDisplayMenu(): (() => void) | undefined {
  const root = document.documentElement;
  const menu = document.querySelector<HTMLElement>("[data-display]");
  const toggle = menu?.querySelector<HTMLButtonElement>("[data-display-toggle]");
  const panel = toggle && document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  const status = menu?.querySelector<HTMLElement>("[data-display-status]");
  if (!menu || !toggle || !panel || !status) return undefined;

  const radios = (name: string) =>
    Array.from(menu.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));
  const labelOf = (input: HTMLInputElement) => input.parentElement?.textContent?.trim() ?? "";
  for (const input of radios("theme")) input.checked = input.value === root.dataset.theme;
  // The picker is only built in "visitor picks" mode; never offer it otherwise.
  if (root.dataset.paletteMode !== "pick") menu.querySelector("[data-palette-picker]")?.remove();
  for (const input of radios("palette")) input.checked = input.value === root.dataset.palette;
  menu.hidden = false;

  const setOpen = (open: boolean) => {
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  };
  const onToggle = () => setOpen(panel.hidden);
  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === "theme" && (THEMES as readonly string[]).includes(input.value)) {
      root.dataset.theme = input.value;
      save(KEYS.theme, input.value === "system" ? null : input.value);
      status.textContent = `Theme: ${labelOf(input)}`;
    } else if (input.name === "palette") {
      root.dataset.palette = input.value;
      save(KEYS.palette, input.value);
      status.textContent = `Colours: ${labelOf(input)}`;
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  };
  const onOutside = (event: Event) => {
    const target = event.target;
    if (!panel.hidden && !(target instanceof Node && menu.contains(target))) setOpen(false);
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !menu.contains(next)) setOpen(false);
  };

  toggle.addEventListener("click", onToggle);
  menu.addEventListener("change", onChange);
  menu.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onOutside);
  return () => {
    toggle.removeEventListener("click", onToggle);
    menu.removeEventListener("change", onChange);
    menu.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onOutside);
    menu.hidden = true;
  };
}
