// The public CV's logic, apart from its markup: what the API's status says may
// be shown, how a one-minute link is asked for and used, the copy request, and
// the words for each answer. It matches api/core/cv.py and core/cv_views.py.
// Nothing here stores or logs a link: a link is held in a variable for the
// minute it works and never put in a page address.

import { emailProblem, HIDDEN, waitText } from "@/lib/public/contact";

export type CvStatus = {
  canView: boolean;
  canRequest: boolean;
  /** The API leaves the key out when it is off, so a missing key is off. */
  instantDownload: boolean;
  updated: string | null;
};

const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export function parseStatus(body: unknown): CvStatus | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (typeof data.can_view !== "boolean" || typeof data.can_request !== "boolean") return null;
  return {
    canView: data.can_view,
    canRequest: data.can_request,
    instantDownload: data.instant_download === true,
    updated: typeof data.updated === "string" && DAY.test(data.updated) ? data.updated : null,
  };
}

/** Whether the site says anything about a CV: only if a button or the form would show. */
export function cvShown(status: CvStatus | null): boolean {
  return Boolean(status && (status.canView || status.canRequest));
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const PLAIN: RequestInit = {
  credentials: "omit",
  referrerPolicy: "no-referrer",
  cache: "no-store",
};

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** The status, or null if it cannot be had: then the site shows nothing. */
export async function fetchStatus(fetcher: Fetcher, origin: string): Promise<CvStatus | null> {
  try {
    const response = await fetcher(`${origin}/api/v1/cv`, { ...PLAIN, cache: "default" });
    return response.ok ? parseStatus(await jsonOf(response)) : null;
  } catch {
    return null;
  }
}

const LINK_PATH = /^\/api\/v1\/cv\/file\/[A-Za-z0-9_:.-]{1,400}$/;
const LINK_SECONDS = 60;

/** The absolute link from an answer, only if it has the documented shape. */
export function linkFrom(body: unknown, origin: string): string | null {
  if (!body || typeof body !== "object") return null;
  const { url, expires_in: expires } = body as { url?: unknown; expires_in?: unknown };
  if (typeof url !== "string" || expires !== LINK_SECONDS) return null;
  if (!LINK_PATH.test(url) || url.includes("..")) return null;
  return `${origin}${url}`;
}

function waitFrom(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
}

export type Failure =
  | { kind: "check" }
  | { kind: "forbidden" }
  | { kind: "limited"; seconds: number }
  | { kind: "unavailable" }
  | { kind: "failed" };

function failureOf(response: Response, body: unknown): Failure {
  if (response.status === 400 && (body as { code?: unknown } | null)?.code === "challenge") {
    return { kind: "check" };
  }
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 429) return { kind: "limited", seconds: waitFrom(response) };
  if (response.status === 503) return { kind: "unavailable" };
  return { kind: "failed" };
}

export type LinkOutcome = { kind: "link"; url: string } | Failure;

/** Ask for the minute's link to view the CV. Only the Turnstile token goes. */
export async function requestViewLink(fetcher: Fetcher, origin: string, token: string): Promise<LinkOutcome> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/v1/cv/link`, {
      ...PLAIN,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile: token }),
    });
  } catch {
    return { kind: "failed" };
  }
  const body = await jsonOf(response);
  if (response.status === 200) {
    const url = linkFrom(body, origin);
    return url ? { kind: "link", url } : { kind: "failed" };
  }
  return failureOf(response, body);
}

export type FileOutcome =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "expired" }
  | Exclude<Failure, { kind: "check" }>;

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** The PDF's bytes from a link, read with a fetch: the link is never navigated to. */
export async function fetchFile(fetcher: Fetcher, url: string): Promise<FileOutcome> {
  let response: Response;
  try {
    response = await fetcher(url, { ...PLAIN, method: "GET" });
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 404) return { kind: "expired" };
  if (response.status !== 200) {
    const failure = failureOf(response, null);
    return failure.kind === "check" ? { kind: "failed" } : failure;
  }
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return MAGIC.every((byte, i) => bytes[i] === byte) ? { kind: "pdf", bytes } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

// The request form ----------------------------------------------------------

export const CV_NOTE_MAX = 500;
export const CV_NAME_MAX = 100;

export type RequestFieldName = "name" | "email" | "note";
export type RequestErrors = Partial<Record<RequestFieldName, string>>;
export type RequestValues = { name: string; email: string; note: string };

export const REQUEST_FIELDS: readonly RequestFieldName[] = ["name", "email", "note"];

export const REQUEST_LABEL: Record<RequestFieldName, string> = {
  name: "Name",
  email: "Email",
  note: "Note",
};

export function tidyRequest(values: RequestValues): RequestValues {
  return {
    name: values.name.replace(HIDDEN, "").trim(),
    email: values.email.replace(HIDDEN, "").trim(),
    note: values.note.replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim(),
  };
}

export function validateRequest(raw: RequestValues): RequestErrors {
  const values = tidyRequest(raw);
  const errors: RequestErrors = {};
  if (values.name.length > CV_NAME_MAX) errors.name = `Use ${CV_NAME_MAX} characters or fewer.`;
  const email = emailProblem(values.email);
  if (email) errors.email = email;
  if (values.note.length > CV_NOTE_MAX) errors.note = `Use ${CV_NOTE_MAX} characters or fewer.`;
  return errors;
}

export function requestProblems(errors: RequestErrors): RequestFieldName[] {
  return REQUEST_FIELDS.filter((name) => errors[name]);
}

export function requestSummary(errors: RequestErrors): string {
  const names = requestProblems(errors).map((name) => REQUEST_LABEL[name]);
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return names.length === 1
    ? `The request was not sent. There is a problem with ${list}.`
    : `The request was not sent. There are ${names.length} problems: ${list}.`;
}

export type RequestPayload = RequestValues & { website: string; elapsed: number; turnstile: string };

export type RequestOutcome =
  | { kind: "sent"; download: string | null }
  | { kind: "fields"; errors: RequestErrors }
  | Failure;

function fieldErrors(body: unknown): RequestErrors | null {
  const raw = (body as { errors?: unknown } | null)?.errors;
  if (!raw || typeof raw !== "object") return null;
  const errors: RequestErrors = {};
  for (const [name, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value.find((entry) => typeof entry === "string") : undefined;
    if ((REQUEST_FIELDS as readonly string[]).includes(name) && typeof first === "string") {
      errors[name as RequestFieldName] = first;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Send the request. Every successful answer is the same to the visitor: the
 * API answers alike for a stored, held-back and blocked sender, so nothing
 * here looks at more than the status and, for a link, its documented shape.
 */
export async function sendCvRequest(
  fetcher: Fetcher,
  origin: string,
  payload: RequestPayload,
): Promise<RequestOutcome> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/v1/cv/request`, {
      ...PLAIN,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "failed" };
  }
  const body = await jsonOf(response);
  if (response.status === 200 || response.status === 201) {
    return { kind: "sent", download: linkFrom(body, origin) };
  }
  if (response.status === 400 && (body as { code?: unknown } | null)?.code !== "challenge") {
    const errors = fieldErrors(body);
    return errors ? { kind: "fields", errors } : { kind: "failed" };
  }
  return failureOf(response, body);
}

// Words ---------------------------------------------------------------------

export const CV_TITLE = "CV";
export const VIEWER_TITLE = "CV";
export const IMAGE_ALTERNATIVE = "The CV is shown as page images. For an accessible copy, request one.";
export const LINK_NOTE = "The link works for a minute.";

export function viewFailureText(failure: Failure | { kind: "expired" }): string {
  switch (failure.kind) {
    case "check":
      return "The anti-spam check did not pass. Please try again.";
    case "forbidden":
      return "The CV cannot be shown at the moment.";
    case "limited":
      return `Too many views have been asked for from here. Please try again in about ${waitText(failure.seconds)}.`;
    case "unavailable":
      return "The CV could not be shown right now. Please try again shortly.";
    case "expired":
      return "The link has expired. Try again to get a new one.";
    default:
      return "The CV could not be shown. Check your connection and try again.";
  }
}

export function requestFailureText(failure: Failure): string {
  switch (failure.kind) {
    case "check":
      return "The anti-spam check did not pass. Please try again.";
    case "forbidden":
      return "Requests for the CV are not available at the moment.";
    case "limited":
      return `Too many requests have been sent from here. Please try again in about ${waitText(failure.seconds)}.`;
    case "unavailable":
      return "The request could not be sent right now. Please try again shortly.";
    default:
      return "The request could not be sent. Check your connection and try again.";
  }
}

export const VIEW_CHECK_FAILED_TEXT = "The anti-spam check could not run. Check your connection and try again.";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Updated 20 November 2026." from the API's date, or "" without one. */
export function updatedText(updated: string | null): string {
  const match = updated ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(updated) : null;
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `Updated ${Number(match[3])} ${month} ${match[1]}.` : "";
}
