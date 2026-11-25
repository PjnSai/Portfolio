import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  CV_IDS,
  CvRequestView,
  INITIAL_REQUEST,
  type RequestState,
} from "@/components/public/CvRequestForm";
import { CHECK_FAILED_TEXT, elapsedMs, SENT_TEXT } from "@/lib/public/contact";
import {
  type RequestErrors,
  requestFailureText,
  requestProblems,
  requestSummary,
  sendCvRequest,
  tidyRequest,
  validateRequest,
} from "@/lib/public/cv";

const LINK_MS = 60_000;

function text(form: HTMLFormElement, name: string) {
  // The fields have no names (see CvRequestForm), so they are read by id.
  return form.querySelector<HTMLInputElement>(`#cv-request-${name}`)?.value ?? "";
}

/**
 * The request form. It takes a Turnstile token from the block's one check, sends
 * the request, and shows the same received message for every successful answer.
 * If the answer carried a download link, a button for it is shown until the
 * link's minute is up.
 */
export function CvRequest({
  origin,
  getToken,
  instant,
}: {
  origin: string;
  getToken: () => Promise<string>;
  instant: boolean;
}) {
  const [state, setState] = useState<RequestState>({ ...INITIAL_REQUEST, ready: true });
  const opened = useRef(0);
  const focusSent = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    opened.current = performance.now();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (state.status === "sent" && focusSent.current) {
      focusSent.current = false;
      document.getElementById(CV_IDS.sent)?.focus();
    }
  });

  function stop(announcement: string, errors: RequestErrors = {}) {
    setState({ ...INITIAL_REQUEST, ready: true, errors, announcement });
    const first = requestProblems(errors)[0];
    if (first) document.getElementById(`cv-request-${first}`)?.focus();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status === "sending") return;
    const form = event.currentTarget;
    const values = { name: text(form, "name"), email: text(form, "email"), note: text(form, "note") };
    const errors = validateRequest(values);
    if (requestProblems(errors).length > 0) {
      stop(requestSummary(errors), errors);
      return;
    }
    setState({ ...INITIAL_REQUEST, ready: true, status: "sending", announcement: "Sending your request…" });
    let token: string;
    try {
      token = await getToken();
    } catch {
      stop(CHECK_FAILED_TEXT);
      return;
    }
    const outcome = await sendCvRequest((url, init) => fetch(url, init), origin, {
      ...tidyRequest(values),
      website: text(form, "website"),
      elapsed: elapsedMs(opened.current, performance.now()),
      turnstile: token,
    });
    if (outcome.kind === "sent") {
      focusSent.current = true;
      setState({
        ...INITIAL_REQUEST,
        ready: true,
        status: "sent",
        announcement: SENT_TEXT,
        download: outcome.download,
      });
      if (outcome.download) {
        timer.current = setTimeout(() => setState((now) => ({ ...now, expired: true })), LINK_MS);
      }
    } else if (outcome.kind === "fields") {
      stop(requestSummary(outcome.errors), outcome.errors);
    } else {
      stop(requestFailureText(outcome));
    }
  }

  return (
    <div id={CV_IDS.wrapper} className="cv__request">
      <CvRequestView state={state} instant={instant} onSubmit={(event) => void onSubmit(event)} />
    </div>
  );
}
