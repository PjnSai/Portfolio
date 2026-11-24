import { expect, type Page } from "@playwright/test";

/** Resolves once the browser has drawn `count` more frames. */
export const frames = (page: Page, count = 3) =>
  page.evaluate(
    (left) =>
      new Promise<void>((done) => {
        const step = (n: number) => (n ? requestAnimationFrame(() => step(n - 1)) : done());
        step(left);
      }),
    count,
  );

/** Nothing is left that could still move the page: fonts are in, no animation
 * or transition that ends is running (a looping one, such as the marquee,
 * never ends and moves nothing else), and frames have been drawn since. */
export async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      ),
    )
    .toBe(true);
  await frames(page);
}
