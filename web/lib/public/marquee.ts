// The skills strip. Prerendered as one static, wrapping list. With this script
// it scrolls in a loop: a copy of the list is added for the seamless join,
// hidden from screen readers and from Tab. It has a pause button, stops on
// hover and while anything inside has focus (both in the stylesheet), and
// starts paused under prefers-reduced-motion. The visitor can still play it.

export function setupMarquee(root: HTMLElement): () => void {
  const track = root.querySelector<HTMLElement>("[data-marquee-track]");
  const list = track?.querySelector<HTMLElement>("ul");
  const button = root.querySelector<HTMLButtonElement>("[data-marquee-toggle]");
  const word = button?.querySelector<HTMLElement>("[data-marquee-word]");
  const status = root.querySelector<HTMLElement>("[data-marquee-status]");
  if (!track || !list || !button || !word || !status) return () => {};

  const copy = list.cloneNode(true) as HTMLElement;
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.removeAttribute("aria-label");
  track.append(copy);
  // About three seconds per skill keeps the speed steady whatever the length.
  root.style.setProperty("--strip-time", `${Math.max(20, list.children.length * 3)}s`);

  const set = (playing: boolean, announce: boolean) => {
    root.dataset.state = playing ? "playing" : "paused";
    word.textContent = playing ? "Pause" : "Play";
    if (announce) status.textContent = playing ? "Skills strip playing." : "Skills strip paused.";
  };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  set(!reduce.matches, false);
  button.hidden = false;

  const onClick = () => set(root.dataset.state !== "playing", true);
  button.addEventListener("click", onClick);
  return () => {
    button.removeEventListener("click", onClick);
    button.hidden = true;
    copy.remove();
    root.style.removeProperty("--strip-time");
    delete root.dataset.state;
  };
}
