// pdf.js behind two small functions. It is brought in only here, only when the
// viewer opens, and its worker is a file of this site's own build: no network
// address, no script from another origin.

import { fitScale, PDF_OPTIONS } from "@/lib/public/cv-viewer";

export type LoadedPdf = {
  pages: number;
  /** Draw one page to fill `boxWidth` CSS pixels. */
  renderPage: (index: number, canvas: HTMLCanvasElement, boxWidth: number) => Promise<void>;
  destroy: () => Promise<void>;
};

const MAX_DEVICE_RATIO = 2;

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: bytes, ...PDF_OPTIONS });
  const doc = await task.promise;
  return {
    pages: doc.numPages,
    async renderPage(index, canvas, boxWidth) {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_RATIO);
      const viewport = page.getViewport({ scale: fitScale(boxWidth, base.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
    },
    destroy: () => task.destroy(),
  };
}
