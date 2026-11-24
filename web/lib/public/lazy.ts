// When a piece of the page fetches its code. Kept apart from the code it
// fetches, so this is all that loads with the page.

export const NEAR_VIEWPORT = "400px 0px";

type ObserverClass = new (
  callback: (entries: { isIntersecting: boolean }[]) => void,
  options?: { rootMargin?: string },
) => { observe: (target: Element) => void; disconnect: () => void };

/**
 * Fetch the form's code once: when the form is within a screen of the visible
 * page, or the moment something in it has or takes focus, whichever comes first. With
 * no IntersectionObserver the first focus is the only trigger. Returns a
 * function that stops watching.
 */
export function armLazyLoad(root: HTMLElement, load: () => void, Observer?: ObserverClass): () => void {
  let done = false;
  const observer = Observer
    ? new Observer(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) go();
        },
        { rootMargin: NEAR_VIEWPORT },
      )
    : null;
  function stop() {
    observer?.disconnect();
    root.removeEventListener("focusin", go);
  }
  function go() {
    if (done) return;
    done = true;
    stop();
    load();
  }
  root.addEventListener("focusin", go);
  observer?.observe(root);
  // A field may have taken focus before this code ran.
  if (root.matches(":focus-within")) go();
  return () => {
    done = true;
    stop();
  };
}
