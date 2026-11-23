// The contact form's logic, apart from its markup: what is checked before
// sending, how the API's answers are told to the visitor, how Cloudflare
// Turnstile's script is loaded and used, and when the form's code is fetched.
// Nothing here runs until the form's own code has been fetched, and it holds
// no copy of the message: the form reads its fields when it sends.

export type Reason = "hiring" | "project" | "other";
export type FieldName = "name" | "email" | "reason" | "body";
export type Errors = Partial<Record<FieldName, string>>;

export type Values = {
  name: string;
  email: string;
  reason: string;
  body: string;
};

/** The same limits as api/core/contact.py; the API is the one that decides. */
export const LIMITS = { name: 100, email: 254, bodyMin: 10, bodyMax: 4000 } as const;

export const REASONS: readonly { value: "" | Reason; label: string }[] = [
  { value: "", label: "Choose a reason (optional)" },
  { value: "hiring", label: "Hiring" },
  { value: "project", label: "A project" },
  { value: "other", label: "Something else" },
];

export const FIELD_LABEL: Record<FieldName, string> = {
  name: "Name",
  email: "Email",
  reason: "Reason",
  body: "Message",
};

/** Order in the form, so the first problem is the first one a person meets. */
export const FIELD_ORDER: readonly FieldName[] = ["name", "email", "reason", "body"];

const EMAIL_BAD = /[\s"<>,;()[\]\\]/;
/** Control characters and the marks that hide or reorder text, as numbers so no
 * invisible character sits in this file. Mirrors api/core/contact.py. */
const HIDDEN = new RegExp(
  `[${[
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([low, high]) => `${String.fromCharCode(low)}-${String.fromCharCode(high)}`)
    .join("")}]`,
  "g",
);

export function tidy(values: Values): Values {
  return {
    name: values.name.replace(HIDDEN, "").trim(),
    email: values.email.replace(HIDDEN, "").trim(),
    reason: values.reason,
    body: values.body.replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim(),
  };
}

function emailProblem(email: string): string {
  const at = email.indexOf("@");
  const ok =
    email.length > 0 &&
    email.length <= LIMITS.email &&
    !EMAIL_BAD.test(email) &&
    at > 0 &&
    at === email.lastIndexOf("@") &&
    email.slice(at + 1).includes(".") &&
    !email.endsWith(".") &&
    !email.slice(at + 1).startsWith(".");
  return ok ? "" : "Enter a valid email address.";
}

/** What is wrong with the values, field by field. Empty when nothing is. */
export function validate(raw: Values): Errors {
  const values = tidy(raw);
  const errors: Errors = {};
  if (values.name.length < 1) errors.name = "Enter your name.";
  else if (values.name.length > LIMITS.name) errors.name = `Use ${LIMITS.name} characters or fewer.`;
  const email = emailProblem(values.email);
  if (email) errors.email = email;
  if (values.reason !== "" && !REASONS.some((reason) => reason.value === values.reason)) {
    errors.reason = "Choose one of the options.";
  }
  if (values.body.length < LIMITS.bodyMin) errors.body = "Write a little more.";
  else if (values.body.length > LIMITS.bodyMax) errors.body = `Use ${LIMITS.bodyMax} characters or fewer.`;
  return errors;
}

/** The names of the fields with a problem, in form order. */
export function problems(errors: Errors): FieldName[] {
  return FIELD_ORDER.filter((name) => errors[name]);
}

/** One sentence for the live region: how many problems and which fields. */
export function summary(errors: Errors): string {
  const names = problems(errors).map((name) => FIELD_LABEL[name]);
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return names.length === 1
    ? `The message was not sent. There is a problem with ${list}.`
    : `The message was not sent. There are ${names.length} problems: ${list}.`;
}

export type Payload = Values & { website: string; elapsed: number; turnstile: string };

export type Outcome =
  | { kind: "sent" }
  | { kind: "fields"; errors: Errors }
  | { kind: "check" }
  | { kind: "limited"; seconds: number }
  | { kind: "unavailable" }
  | { kind: "failed" };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const FIELDS = new Set<string>(FIELD_ORDER);

function fieldErrors(body: unknown): Errors | null {
  const raw = (body as { errors?: unknown } | null)?.errors;
  if (!raw || typeof raw !== "object") return null;
  const errors: Errors = {};
  for (const [name, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value.find((entry) => typeof entry === "string") : undefined;
    if (FIELDS.has(name) && typeof first === "string") errors[name as FieldName] = first;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Send the message. No cookie, no referrer and no credentials go with it: the
 * only thing the API gets is the form. Every answer becomes one outcome the
 * form can say in words; none of them says which other check failed.
 */
export async function send(fetcher: Fetcher, origin: string, payload: Payload): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/v1/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    return { kind: "failed" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 201) return { kind: "sent" };
  if (response.status === 400) {
    if ((body as { code?: unknown } | null)?.code === "challenge") return { kind: "check" };
    const errors = fieldErrors(body);
    return errors ? { kind: "fields", errors } : { kind: "failed" };
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    return { kind: "limited", seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 3600 };
  }
  if (response.status === 503) return { kind: "unavailable" };
  return { kind: "failed" };
}

/** How long to wait, in words a visitor can use. */
export function waitText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** The sentence for an outcome that is not a success and not field errors. */
export function outcomeText(outcome: Outcome): string {
  switch (outcome.kind) {
    case "check":
      return "The anti-spam check did not pass. Please try again.";
    case "limited":
      return `Too many messages have been sent from here. Please try again in about ${waitText(outcome.seconds)}, or use one of the links below.`;
    case "unavailable":
      return "The message could not be sent right now. Please try again shortly, or use one of the links below.";
    case "failed":
      return "The message could not be sent. Check your connection and try again, or use one of the links below.";
    default:
      return "";
  }
}

export const SENT_TEXT = "Thank you. Your message has been received.";
export const CHECK_FAILED_TEXT =
  "The anti-spam check could not run. Check your connection and try again, or use one of the links below.";

// Cloudflare Turnstile ------------------------------------------------------

export const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

type TurnstileWindow = Window & { turnstile?: TurnstileApi };

let loading: Promise<TurnstileApi> | null = null;

/** Add Turnstile's script once and wait for it. Rejects if it cannot load. */
export function loadTurnstile(doc: Document, win: TurnstileWindow): Promise<TurnstileApi> {
  if (win.turnstile) return Promise.resolve(win.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => (win.turnstile ? resolve(win.turnstile) : reject(new Error("Turnstile missing")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile did not load"));
    };
    doc.head.append(script);
  });
  return loading;
}

/** For tests: forget a finished or failed load. */
export function resetTurnstileLoader(): void {
  loading = null;
}

export const TOKEN_TIMEOUT_MS = 30_000;

export type Checker = {
  /** A fresh single-use token. Rejects if the check fails or takes too long. */
  token: () => Promise<string>;
  dispose: () => void;
};

/**
 * Turnstile in its invisible mode: the widget is drawn once, and run each time
 * the form is sent. A token works once, so the widget is reset before each use.
 */
export function createChecker(api: TurnstileApi, container: HTMLElement, sitekey: string, timeout = TOKEN_TIMEOUT_MS): Checker {
  let settle: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
  const fail = (reason: string) => () => {
    settle?.reject(new Error(reason));
    settle = null;
  };
  const id = api.render(container, {
    sitekey,
    execution: "execute",
    appearance: "interaction-only",
    callback: (token: string) => {
      settle?.resolve(token);
      settle = null;
    },
    "error-callback": fail("check failed"),
    "expired-callback": fail("check expired"),
    "timeout-callback": fail("check timed out"),
  });
  let used = false;
  return {
    token() {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle = null;
          reject(new Error("check took too long"));
        }, timeout);
        settle = {
          resolve: (token) => {
            clearTimeout(timer);
            resolve(token);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        if (used) api.reset(id);
        used = true;
        api.execute(id);
      });
    },
    dispose() {
      api.remove(id);
    },
  };
}

/** Whole seconds since `from`, as the form reports how long it was open. */
export function elapsedMs(from: number, now: number): number {
  return Math.max(0, Math.round(now - from));
}
