// The project showcase. The page holds a plain list of cards; this turns it into
// the owner's layout. Positions are a data-offset attribute per card that the
// stylesheet maps to a transform, so no style is written. 3D only on a wide
// screen with a fine pointer and no reduced-motion preference; otherwise a
// flat swipe carousel (scroll snap) with the same controls.

export const LAYOUTS = ["ring", "vertical", "stack", "train"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_NAMES: Record<Layout, string> = {
  ring: "Ring",
  vertical: "Vertical",
  stack: "Stack",
  train: "Train",
};

export const layoutOf = (value: unknown): Layout =>
  LAYOUTS.includes(value as Layout) ? (value as Layout) : "ring";

export const THREE_D = "(min-width: 760px) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
const MAX_OFFSET = 3;
const SWIPE = 48;

/** Where card `index` sits relative to the front card. Ring layouts wrap round,
    so the last card sits just before the first. */
export function offsetOf(index: number, active: number, count: number, circular: boolean): number {
  let offset = index - active;
  if (circular && count > 2) {
    const half = Math.floor(count / 2);
    offset = ((((offset + half) % count) + count) % count) - half;
  }
  return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, offset));
}

export const counterText = (active: number, count: number) =>
  `${String(active + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`;

const circular = (layout: string | undefined) => layout === "ring" || layout === "vertical";

export function setupShowcase(root: HTMLElement): () => void {
  const deck = root.querySelector<HTMLElement>("[data-showcase-deck]");
  const controls = root.querySelector<HTMLElement>("[data-showcase-controls]");
  const prev = root.querySelector<HTMLButtonElement>("[data-showcase-prev]");
  const next = root.querySelector<HTMLButtonElement>("[data-showcase-next]");
  const counter = root.querySelector<HTMLElement>("[data-showcase-count]");
  const status = root.querySelector<HTMLElement>("[data-showcase-status]");
  const sheet = root.querySelector<HTMLDialogElement>("[data-showcase-sheet]");
  const sheetBody = root.querySelector<HTMLElement>("[data-showcase-sheet-body]");
  const close = root.querySelector<HTMLButtonElement>("[data-showcase-close]");
  const switcher = root.querySelector<HTMLFieldSetElement>("[data-showcase-switch]");
  const dots = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-showcase-dot]"));
  if (!deck || !controls || !prev || !next || !counter || !status || !sheet || !sheetBody || !close) {
    return () => {};
  }
  const slots = Array.from(deck.querySelectorAll<HTMLElement>(":scope > [data-slot]"));
  const count = slots.length;
  if (count === 0) return () => {};

  const wide = window.matchMedia(THREE_D);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let active = 0;
  const mode = () => root.dataset.mode;
  const cardOf = (i: number) => slots[i].querySelector<HTMLElement>(".card");
  const titleLink = (i: number) => slots[i].querySelector<HTMLAnchorElement>(".card__title a");
  const titleOf = (i: number) => titleLink(i)?.textContent?.trim() ?? "";

  function paint() {
    const threeD = mode() === "3d";
    slots.forEach((slot, i) => {
      const front = !threeD || i === active;
      if (threeD) slot.dataset.offset = String(offsetOf(i, active, count, circular(root.dataset.layout)));
      else delete slot.dataset.offset;
      // Only the front card matters to a screen reader and the Tab key; side
      // cards stay clickable, so they are not inert.
      if (front) slot.removeAttribute("aria-hidden");
      else slot.setAttribute("aria-hidden", "true");
      for (const el of slot.querySelectorAll<HTMLElement>("a[href], button")) {
        if (front) el.removeAttribute("tabindex");
        else el.tabIndex = -1;
      }
    });
    dots.forEach((dot, i) => {
      if (i === active) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    counter!.textContent = counterText(active, count);
  }

  // While a button moves the carousel smoothly, the cards it passes are not
  // the visitor's choice: in-view updates wait until the target arrives, so a
  // second press counts from the target, not from a card on the way.
  let heading: number | null = null;
  let headingTimer = 0;
  function scrollToActive(smooth: boolean) {
    const smoothly = smooth && !reduce.matches;
    window.clearTimeout(headingTimer);
    heading = smoothly ? active : null;
    if (smoothly) headingTimer = window.setTimeout(() => (heading = null), 1000);
    deck!.scrollTo({ left: slots[active].offsetLeft, behavior: smoothly ? "smooth" : "auto" });
  }

  function go(index: number, { focusCard = false, announce = true } = {}) {
    active = ((index % count) + count) % count;
    paint();
    if (mode() === "flat") scrollToActive(true);
    if (announce) status!.textContent = `Project ${active + 1} of ${count}: ${titleOf(active)}`;
    if (focusCard) titleLink(active)?.focus({ preventScroll: mode() === "3d" });
  }

  function setMode() {
    root.dataset.mode = wide.matches ? "3d" : "flat";
    paint();
    if (mode() === "flat") scrollToActive(false);
  }

  function open(index: number) {
    const card = cardOf(index);
    const link = titleLink(index);
    if (!card || !link) return;
    if (index !== active) go(index, { announce: false });
    const copy = card.cloneNode(true) as HTMLElement;
    copy.removeAttribute("id");
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    for (const el of copy.querySelectorAll("[tabindex]")) el.removeAttribute("tabindex");
    copy.classList.add("sheet__card");
    copy.querySelector(".card__title")?.setAttribute("id", "showcase-sheet-title");
    const more = document.createElement("p");
    more.className = "sheet__case";
    const caseLink = document.createElement("a");
    caseLink.className = "btn btn--fill";
    caseLink.href = link.href;
    caseLink.textContent = "Full case study";
    more.append(caseLink);
    copy.querySelector(".card__body")?.append(more);
    sheetBody!.replaceChildren(copy);
    sheet!.dataset.accent = card.dataset.accent ?? "primary";
    if (!sheet!.open) sheet!.showModal();
    close!.focus();
    if (card.id) history.replaceState(history.state, "", `#${card.id}`);
  }

  function fromHash() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const index = id ? slots.findIndex((_, i) => cardOf(i)?.id === id) : -1;
    if (index >= 0) open(index);
  }

  const onPrev = () => go(active - 1);
  const onNext = () => go(active + 1);
  const onDot = (event: Event) => {
    const index = dots.indexOf(event.currentTarget as HTMLButtonElement);
    if (index >= 0) go(index);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (switcher?.contains(target) || sheet.contains(target)) return;
    const vertical = mode() === "3d" && root.dataset.layout === "vertical";
    const step =
      event.key === "ArrowLeft" || (vertical && event.key === "ArrowUp")
        ? -1
        : event.key === "ArrowRight" || (vertical && event.key === "ArrowDown")
          ? 1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    go(active + step, { focusCard: deck.contains(target) });
  };

  let swiped = false;
  let start: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => {
    start = mode() === "3d" ? { x: event.clientX, y: event.clientY } : null;
  };
  const onUp = (event: PointerEvent) => {
    if (!start) return;
    const vertical = root.dataset.layout === "vertical";
    const along = vertical ? event.clientY - start.y : event.clientX - start.x;
    const across = vertical ? event.clientX - start.x : event.clientY - start.y;
    start = null;
    if (Math.abs(along) < SWIPE || Math.abs(along) < Math.abs(across)) return;
    swiped = true;
    window.setTimeout(() => (swiped = false), 0);
    go(active + (along < 0 ? 1 : -1));
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const slot = target.closest<HTMLElement>("[data-slot]");
    if (!slot) return;
    if (swiped) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const index = slots.indexOf(slot);
    const link = target.closest("a");
    const front = mode() === "flat" || index === active;
    // The front card's own links (a demo, the repository) work as links.
    if (front && link && !link.closest(".card__title")) return;
    event.preventDefault();
    if (front) open(index);
    else go(index);
  };

  const onBackdrop = (event: MouseEvent) => {
    if (event.target === sheet) sheet.close();
  };
  const onClose = () => sheet.close();
  const onSheetClosed = () => {
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    titleLink(active)?.focus({ preventScroll: true });
  };

  const onLayout = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== "showcase-layout") return;
    root.dataset.layout = layoutOf(input.value);
    paint();
    status.textContent = `Layout: ${LAYOUT_NAMES[layoutOf(input.value)]}`;
  };

  // In the carousel the visitor scrolls; the front card is the one in view.
  const seen = new Map<Element, number>();
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            if (mode() !== "flat") return;
            for (const entry of entries) seen.set(entry.target, entry.intersectionRatio);
            const index = slots.findIndex((slot) => (seen.get(slot) ?? 0) >= 0.6);
            if (heading !== null) {
              if (index === heading) heading = null;
              return;
            }
            if (index >= 0 && index !== active) {
              active = index;
              paint();
            }
          },
          { root: deck, threshold: [0, 0.6, 1] },
        )
      : null;
  for (const slot of slots) observer?.observe(slot);

  root.dataset.enhanced = "true";
  controls.hidden = count < 2;
  if (switcher) {
    switcher.hidden = false;
    for (const input of switcher.querySelectorAll<HTMLInputElement>("input")) {
      input.checked = input.value === root.dataset.layout;
    }
  }
  setMode();
  fromHash();

  prev.addEventListener("click", onPrev);
  next.addEventListener("click", onNext);
  for (const dot of dots) dot.addEventListener("click", onDot);
  root.addEventListener("keydown", onKey);
  deck.addEventListener("pointerdown", onDown);
  deck.addEventListener("pointerup", onUp);
  deck.addEventListener("click", onClick);
  sheet.addEventListener("click", onBackdrop);
  sheet.addEventListener("close", onSheetClosed);
  close.addEventListener("click", onClose);
  switcher?.addEventListener("change", onLayout);
  wide.addEventListener("change", setMode);
  window.addEventListener("hashchange", fromHash);
  return () => {
    prev.removeEventListener("click", onPrev);
    next.removeEventListener("click", onNext);
    for (const dot of dots) dot.removeEventListener("click", onDot);
    root.removeEventListener("keydown", onKey);
    deck.removeEventListener("pointerdown", onDown);
    deck.removeEventListener("pointerup", onUp);
    deck.removeEventListener("click", onClick);
    sheet.removeEventListener("click", onBackdrop);
    sheet.removeEventListener("close", onSheetClosed);
    close.removeEventListener("click", onClose);
    switcher?.removeEventListener("change", onLayout);
    wide.removeEventListener("change", setMode);
    window.removeEventListener("hashchange", fromHash);
    observer?.disconnect();
    window.clearTimeout(headingTimer);
    delete root.dataset.enhanced;
    delete root.dataset.mode;
  };
}
