// The contact form's behaviour. It is fetched only when the form is near the
// viewport or takes focus (ContactLoader), together with Turnstile's script,
// and takes over the markup already on the page.

import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hydrateRoot } from "react-dom/client";
import { ContactFormView, type FormState, IDS, INITIAL_STATE } from "@/components/public/ContactForm";
import {
  CHECK_FAILED_TEXT,
  type Checker,
  createChecker,
  elapsedMs,
  type Errors,
  loadTurnstile,
  outcomeText,
  problems,
  SENT_TEXT,
  send,
  summary,
  tidy,
  validate,
} from "@/lib/public/contact";

type Config = { apiOrigin: string; siteKey: string };

function read(form: HTMLFormElement) {
  // The fields have no names (see ContactForm), so they are read by id.
  const text = (name: string) =>
    form.querySelector<HTMLInputElement>(`#contact-${name}`)?.value ?? "";
  return {
    values: { name: text("name"), email: text("email"), reason: text("reason"), body: text("body") },
    website: text("website"),
  };
}

/** Keep the form's box as tall as it was (or let it shrink again), so nothing below moves. */
function holdHeight(root: HTMLElement, hold: boolean) {
  // The computed height keeps the fraction that offsetHeight rounds away.
  root.style.minHeight = hold ? getComputedStyle(root).height : "";
}

const never = () => () => undefined;

function focusFirst(errors: Errors) {
  const first = problems(errors)[0];
  if (first) document.getElementById(`contact-${first}`)?.focus();
}

function ContactApp({ config, root }: { config: Config; root: HTMLElement }) {
  // False while taking over the markup, which was written with the button off,
  // then true: the way React says a value differs between the two.
  const ready = useSyncExternalStore(never, () => true, () => false);
  const [state, setState] = useState<FormState>(INITIAL_STATE);
  const checker = useRef<Promise<Checker> | null>(null);
  const opened = useRef(0);
  const focusSent = useRef(false);

  useEffect(() => {
    opened.current = performance.now();
    // Turnstile's script is fetched now, not at page load.
    const container = root.querySelector<HTMLElement>("[data-turnstile]");
    if (container) {
      checker.current = loadTurnstile(document, window).then((api) =>
        createChecker(api, container, config.siteKey),
      );
      checker.current.catch(() => undefined);
    }
    return () => {
      void checker.current?.then((made) => made.dispose()).catch(() => undefined);
    };
  }, [root, config.siteKey]);

  // After the sent panel is drawn, put focus on it so the result is read out.
  useEffect(() => {
    if (state.status === "sent" && focusSent.current) {
      focusSent.current = false;
      document.getElementById(IDS.sent)?.focus();
    }
  });

  function stop(announcement: string, errors: Errors = {}) {
    setState({ status: "idle", errors, announcement, ready });
    focusFirst(errors);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status === "sending") return;
    const { values, website } = read(event.currentTarget);
    const errors = validate(values);
    if (problems(errors).length > 0) {
      stop(summary(errors), errors);
      return;
    }
    setState({ status: "sending", errors: {}, announcement: "Sending your message…", ready });
    let token: string;
    try {
      const made = await checker.current;
      if (!made) throw new Error("no check");
      token = await made.token();
    } catch {
      stop(CHECK_FAILED_TEXT);
      return;
    }
    const outcome = await send((url, init) => fetch(url, init), config.apiOrigin, {
      ...tidy(values),
      website,
      elapsed: elapsedMs(opened.current, performance.now()),
      turnstile: token,
    });
    if (outcome.kind === "sent") {
      holdHeight(root, true);
      focusSent.current = true;
      setState({ status: "sent", errors: {}, announcement: SENT_TEXT, ready });
    } else if (outcome.kind === "fields") {
      stop(summary(outcome.errors), outcome.errors);
    } else {
      stop(outcomeText(outcome));
    }
  }

  return (
    <ContactFormView
      state={{ ...state, ready }}
      onSubmit={onSubmit}
      onAnother={() => {
        holdHeight(root, false);
        setState({ ...INITIAL_STATE, ready });
      }}
    />
  );
}

/** Take over the form already in the page. */
export function mountContact(root: HTMLElement, config: Config) {
  return hydrateRoot(root, <ContactApp config={config} root={root} />);
}
