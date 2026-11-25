// The CV block's behaviour. It is fetched when the block is near the page
// (CvLoader), asks the API what is on, and draws nothing if nothing is. The
// viewer and pdf.js are fetched only when a visitor has passed the human check.

import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CvRequest } from "@/components/public/CvRequest";
import { CvSectionView, SECTION_IDS } from "@/components/public/CvSection";
import type { CvViewerProps } from "@/components/public/CvViewer";
import { type Checker, createChecker, loadTurnstile } from "@/lib/public/contact";
import { type CvStatus, cvShown, fetchStatus, VIEW_CHECK_FAILED_TEXT } from "@/lib/public/cv";

type Config = { apiOrigin: string; siteKey: string };
type Viewer = { token: string; View: ComponentType<CvViewerProps> };

const VIEWER_FAILED_TEXT = "The viewer could not be loaded. Reload the page and try again.";

function CvApp({ config, root }: { config: Config; root: HTMLElement }) {
  const [status, setStatus] = useState<CvStatus | null>(null);
  const [note, setNote] = useState("");
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const checker = useRef<Promise<Checker> | null>(null);
  const toRequest = useRef(false);

  useEffect(() => {
    let live = true;
    void fetchStatus((url, init) => fetch(url, init), config.apiOrigin).then((found) => {
      if (live) setStatus(found);
    });
    return () => {
      live = false;
    };
  }, [config.apiOrigin]);

  const shown = cvShown(status);

  // Turnstile's script is fetched only once there is something to check.
  useEffect(() => {
    if (!shown) return;
    const container = root.querySelector<HTMLElement>("[data-turnstile]");
    if (!container) return;
    checker.current = loadTurnstile(document, window).then((api) =>
      createChecker(api, container, config.siteKey),
    );
    checker.current.catch(() => undefined);
    return () => {
      void checker.current?.then((made) => made.dispose()).catch(() => undefined);
      checker.current = null;
    };
  }, [root, shown, config.siteKey]);

  const getToken = useCallback(async () => {
    const made = await checker.current;
    if (!made) throw new Error("no check");
    return made.token();
  }, []);

  async function startView() {
    if (note === "Checking that you are human…") return;
    setNote("Checking that you are human…");
    let token: string;
    try {
      token = await getToken();
    } catch {
      setNote(VIEW_CHECK_FAILED_TEXT);
      return;
    }
    try {
      const { CvViewer } = await import("@/components/public/CvViewer");
      setNote("");
      setViewer({ token, View: CvViewer });
    } catch {
      setNote(VIEWER_FAILED_TEXT);
    }
  }

  // After the dialog has gone and the button is on again, focus goes back to
  // the button that opened it, or to the request form if that was chosen.
  const giveBack = useRef(false);
  useEffect(() => {
    if (viewer || !giveBack.current) return;
    giveBack.current = false;
    const form = toRequest.current ? document.getElementById("cv-request") : null;
    toRequest.current = false;
    if (form) {
      form.scrollIntoView({ block: "center" });
      form.querySelector<HTMLElement>("input")?.focus();
    } else {
      // The button itself, not whatever had focus: Safari does not focus a
      // button when it is clicked.
      document.getElementById(SECTION_IDS.view)?.focus();
    }
  }, [viewer]);

  function closed() {
    giveBack.current = true;
    setViewer(null);
  }

  const View = viewer?.View;
  return (
    <>
      <CvSectionView
        status={status}
        note={note}
        busy={note === "Checking that you are human…" || viewer !== null}
        onView={() => void startView()}
        request={status?.canRequest ? <CvRequest origin={config.apiOrigin} getToken={getToken} instant={status.instantDownload} /> : null}
        turnstile={<div data-turnstile className="cv__turnstile" />}
      />
      {View && viewer ? (
        <View
          origin={config.apiOrigin}
          firstToken={viewer.token}
          getToken={getToken}
          canRequest={Boolean(status?.canRequest)}
          onClose={closed}
          onRequest={() => {
            toRequest.current = true;
          }}
        />
      ) : null}
    </>
  );
}

/** Fill the block's empty root. */
export function mountCv(root: HTMLElement, config: Config) {
  return createRoot(root).render(<CvApp config={config} root={root} />);
}
