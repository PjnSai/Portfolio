import type { KeyboardEvent, MouseEvent } from "react";
import { VIEWER_TITLE } from "@/lib/public/cv";
import { pageLabel, type ViewerPhase, viewerStatus } from "@/lib/public/cv-viewer";

// The CV viewer's markup. It has no state and no hooks: CvViewer draws the pages
// into the canvases and moves focus. There is deliberately no download button,
// no link to a file and no frame in it: the pages are canvases and nothing else.

export const DIALOG_IDS = {
  title: "cv-viewer-title",
  status: "cv-viewer-status",
  request: "cv-request",
} as const;

export type CvDialogProps = {
  phase: ViewerPhase;
  pageCount: number;
  /** When the request form is on, the text alternative links to it. */
  canRequest: boolean;
  onClose: () => void;
  onRetry: () => void;
  onRequest: () => void;
  /** Called with the dialog and with each page's canvas, as they are made or removed. */
  onDialog?: (element: HTMLDialogElement | null) => void;
  onCanvas?: (index: number, element: HTMLCanvasElement | null) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
  onBackdrop?: (event: MouseEvent<HTMLDialogElement>) => void;
};

export function CvDialogView({
  phase,
  pageCount,
  canRequest,
  onClose,
  onRetry,
  onRequest,
  onDialog,
  onCanvas,
  onKeyDown,
  onBackdrop,
}: CvDialogProps) {
  const pages = phase.kind === "ready" ? Array.from({ length: pageCount }, (_, i) => i) : [];
  return (
    <dialog
      ref={onDialog}
      className="sheet cv-viewer"
      aria-labelledby={DIALOG_IDS.title}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
    >
      <div className="sheet__inner">
        <div className="cv-viewer__bar">
          <h2 id={DIALOG_IDS.title} className="cv-viewer__title">
            {VIEWER_TITLE}
          </h2>
          <button type="button" className="btn btn--outline" onClick={onClose}>
            Close
          </button>
        </div>
        {phase.kind === "error" ? (
          <div className="cv-viewer__problem">
            <p role="alert">{viewerStatus(phase, pageCount)}</p>
            <button type="button" className="btn btn--fill" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <p id={DIALOG_IDS.status} role="status" aria-live="polite" className="cv-viewer__status">
            {viewerStatus(phase, pageCount)}
          </p>
        )}
        {phase.kind === "ready" && canRequest ? (
          <p className="cv-viewer__alt">
            The CV is shown as page images. For an accessible copy,{" "}
            <a href={`#${DIALOG_IDS.request}`} onClick={(event) => { event.preventDefault(); onRequest(); }}>
              request one
            </a>
            .
          </p>
        ) : null}
        {phase.kind === "ready" ? (
          <div className="cv-viewer__scroll" tabIndex={0} role="group" aria-label="CV pages">
            {pages.map((index) => (
              <canvas
                key={index}
                ref={(element) => onCanvas?.(index, element)}
                className="cv-viewer__page"
                role="img"
                aria-label={pageLabel(index + 1, pageCount)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
