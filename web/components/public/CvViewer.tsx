// The CV viewer's behaviour: a modal dialog that gets a one-minute link,
// reads the file with a fetch (never a navigation, frame or object), and
// draws the pages onto canvases with pdf.js. This file is fetched when the
// visitor has passed the human check; pdf.js itself is fetched only when
// loading begins.

import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { CvDialogView } from "@/components/public/CvDialog";
import { fetchFile, requestViewLink } from "@/lib/public/cv";
import { trapTarget, type ViewerPhase } from "@/lib/public/cv-viewer";
import { type LoadedPdf, loadPdf } from "@/lib/public/pdf";

export type CvViewerProps = {
  origin: string;
  /** A Turnstile token already passed, for the first link. */
  firstToken: string;
  /** A fresh token for a retry. Rejects if the check fails. */
  getToken: () => Promise<string>;
  canRequest: boolean;
  onClose: () => void;
  onRequest: () => void;
};

const fetcher = (url: string, init: RequestInit) => fetch(url, init);

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex="0"]';

export function CvViewer({ origin, firstToken, getToken, canRequest, onClose, onRequest }: CvViewerProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const pdf = useRef<LoadedPdf | null>(null);
  const attempt = useRef(0);
  const [phase, setPhase] = useState<ViewerPhase>({ kind: "loading" });
  const [pageCount, setPageCount] = useState(0);

  const drop = useCallback(() => {
    const old = pdf.current;
    pdf.current = null;
    void old?.destroy().catch(() => undefined);
  }, []);

  const load = useCallback(
    async (token: string) => {
      const mine = ++attempt.current;
      const stale = () => mine !== attempt.current;
      drop();
      setPageCount(0);
      setPhase({ kind: "loading" });
      const link = await requestViewLink(fetcher, origin, token);
      if (stale()) return;
      if (link.kind !== "link") {
        setPhase({ kind: "error", failure: link });
        return;
      }
      const file = await fetchFile(fetcher, link.url);
      if (stale()) return;
      if (file.kind !== "pdf") {
        setPhase({ kind: "error", failure: file });
        return;
      }
      let loaded: LoadedPdf;
      try {
        loaded = await loadPdf(file.bytes);
      } catch {
        if (!stale()) setPhase({ kind: "error", failure: { kind: "failed" } });
        return;
      }
      if (stale()) {
        void loaded.destroy().catch(() => undefined);
        return;
      }
      pdf.current = loaded;
      setPageCount(loaded.pages);
      setPhase({ kind: "ready" });
    },
    [origin, drop],
  );

  // Open as a modal dialog (focus moves in, the page behind is inert, Escape
  // closes it) and get the first link at once: it only lasts a minute.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const closed = () => onClose();
    element.addEventListener("close", closed);
    if (!element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    void load(firstToken);
    return () => {
      element.removeEventListener("close", closed);
      attempt.current += 1;
      drop();
      if (element.open) element.close();
    };
    // The first link is asked for once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw the pages one after another once their canvases exist.
  useEffect(() => {
    if (phase.kind !== "ready" || !pdf.current) return;
    const loaded = pdf.current;
    const box = dialog.current?.querySelector<HTMLElement>(".cv-viewer__scroll");
    const width = box?.clientWidth ?? 600;
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < loaded.pages && !cancelled; index++) {
        const canvas = canvases.current[index];
        if (!canvas) break;
        try {
          await loaded.renderPage(index, canvas, width);
        } catch {
          if (!cancelled) setPhase({ kind: "error", failure: { kind: "failed" } });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, pageCount]);

  // When the button that was pressed goes away (retry), keep focus in the dialog.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.contains(document.activeElement)) {
      element.querySelector<HTMLElement>("button")?.focus();
    }
  }, [phase]);

  async function retry() {
    let token: string;
    setPhase({ kind: "loading" });
    try {
      token = await getToken();
    } catch {
      setPhase({ kind: "error", failure: { kind: "check" } });
      return;
    }
    await load(token);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const active = document.activeElement as HTMLElement | null;
    const target = trapTarget(items, active, event.shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  return (
    <CvDialogView
      phase={phase}
      pageCount={pageCount}
      canRequest={canRequest}
      onDialog={(element) => {
        dialog.current = element;
      }}
      onCanvas={(index, element) => {
        canvases.current[index] = element;
      }}
      onKeyDown={onKeyDown}
      onBackdrop={onBackdrop}
      onClose={() => dialog.current?.close()}
      onRetry={() => void retry()}
      onRequest={() => {
        dialog.current?.close();
        onRequest();
      }}
    />
  );
}
