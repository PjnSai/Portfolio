// Section enter transitions on the home page. Only sections below the fold
// when the script starts are marked pending; the stylesheet hides a pending
// section only under prefers-reduced-motion: no-preference, so without this
// script, or with reduced motion, nothing is ever hidden. A section that takes
// focus or is the target of a jump is shown at once, with no transition, so
// focus never lands in a hidden or half-drawn section.

export function setupSectionMotion(doc: Document = document): () => void {
  const win = doc.defaultView;
  if (!win || !("IntersectionObserver" in win)) return () => {};
  const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) return () => {};

  const hashTarget = () => {
    const id = decodeURIComponent(win.location.hash.slice(1));
    return id ? doc.getElementById(id) : null;
  };
  const target = hashTarget();
  const pending = Array.from(doc.querySelectorAll<HTMLElement>("[data-section]")).filter(
    (section) => section.getBoundingClientRect().top > win.innerHeight && !section.contains(target),
  );
  if (pending.length === 0) return () => {};

  const show = (section: Element | null | undefined, instant: boolean) => {
    if (!(section instanceof HTMLElement) || !section.dataset.reveal) return;
    if (instant) {
      if (section.dataset.reveal !== "now") section.dataset.reveal = "now";
    } else if (section.dataset.reveal === "pending") {
      section.dataset.reveal = "in";
    }
    if (instant || section.dataset.reveal === "in") observer.unobserve(section);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) show(entry.target, false);
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const section of pending) {
    section.dataset.reveal = "pending";
    observer.observe(section);
  }

  const onFocus = (event: FocusEvent) => {
    show((event.target as Element | null)?.closest?.("[data-reveal]"), true);
  };
  const onHash = () => show(hashTarget()?.closest("[data-reveal]"), true);
  const onReduce = () => {
    if (reduce.matches) for (const section of pending) show(section, true);
  };
  doc.addEventListener("focusin", onFocus);
  win.addEventListener("hashchange", onHash);
  reduce.addEventListener("change", onReduce);
  return () => {
    observer.disconnect();
    doc.removeEventListener("focusin", onFocus);
    win.removeEventListener("hashchange", onHash);
    reduce.removeEventListener("change", onReduce);
    for (const section of pending) delete section.dataset.reveal;
  };
}
