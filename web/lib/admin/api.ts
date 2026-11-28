// The admin pages talk to /api/v1/admin on the API's origin (fixed at build
// time), sending its cookies. Every state-changing request carries the CSRF
// token from GET /csrf (or the one a sign-in returns).

import { API_ORIGIN } from "@/lib/api-base";

const BASE = `${API_ORIGIN}/api/v1/admin`;
const SAFE_PATH = /^\/[A-Za-z0-9/_-]*$/;

type Body = Record<string, unknown>;
type Payload = Body | FormData;
type Query = Record<string, string | number | boolean | undefined>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fields: Record<string, string[]>;
  readonly body: Body;

  constructor(status: number, body: Body) {
    super(typeof body.detail === "string" ? body.detail : `HTTP ${status}`);
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : undefined;
    this.fields = flattenErrors(body.errors);
    this.body = body;
  }
}

function messages(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix + value];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      typeof entry === "string" ? [prefix + entry] : messages(entry, `${prefix}Row ${index + 1}: `),
    );
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => messages(entry, prefix));
  }
  return [];
}

/** API field errors (nested for lists and groups) as messages per top-level field. */
export function flattenErrors(errors: unknown): Record<string, string[]> {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return {};
  return Object.fromEntries(
    Object.entries(errors).map(([name, value]) => [name, messages(value)]),
  );
}

/** The owner closed the passkey confirmation without using it. */
export class Cancelled extends Error {}

/** The API answered, but not in the shape this page was built for. */
export class UnexpectedAnswer extends Error {
  constructor() {
    super("Unexpected answer");
  }
}

/** Plain words for the API's named refusals (409 with a code). */
const CONFLICTS: Record<string, string> = {
  contact_exists: "There is already a saved contact for this email address.",
  different_sender:
    "That message is from a different email address, so it cannot be linked to this contact.",
  blocklist_full:
    "The blocklist is full. Remove an entry you no longer need, then try again.",
  passkey_limit:
    "You already have the most passkeys allowed. Remove one you no longer use, then add the new one.",
};

export function describeError(error: unknown): string {
  if (error instanceof Cancelled) {
    return "Nothing was done: the passkey confirmation was closed.";
  }
  if (error instanceof UnexpectedAnswer) {
    return "The server's answer was not what this page expected, so nothing is shown. Reload, and tell the developer if it happens again.";
  }
  if (!(error instanceof ApiError)) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return "The passkey request was cancelled or timed out.";
    }
    return "Something went wrong. Try again.";
  }
  switch (error.status) {
    case 400:
      return Object.keys(error.fields).length
        ? "Some fields need changing."
        : "That request was not accepted.";
    case 401:
      return "You are signed out. Sign in again.";
    case 403:
      return error.code === "elevation_required"
        ? "Confirm with your passkey first."
        : "That is not allowed.";
    case 404:
      return "That no longer exists.";
    case 409:
      return CONFLICTS[error.code ?? ""] ?? "That is not possible right now.";
    case 413:
      return "That file is too large. Use an image under 8 MB.";
    case 429:
      return "Too many attempts. Wait a few minutes and try again.";
    case 503:
      return "The site cannot reach its database. Try again shortly.";
    default:
      return "Something went wrong. Try again.";
  }
}

function url(path: string, query?: Query): string {
  if (!SAFE_PATH.test(path) || path.includes("//") || path.includes("..")) {
    throw new Error("Not an admin path.");
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(name, String(value));
  }
  const search = params.toString();
  return `${BASE}${path}${search ? `?${search}` : ""}`;
}

export function createClient(fetcher: Fetcher = (u, i) => fetch(u, i)) {
  let csrf: string | null = null;

  async function send<T>(method: string, path: string, body?: Payload, query?: Query) {
    const target = url(path, query);
    const headers: Record<string, string> = { Accept: "application/json" };
    const form = body instanceof FormData;
    if (method !== "GET") {
      if (csrf === null) await refreshCsrf();
      // A form body sets its own multipart type and boundary.
      if (!form) headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = csrf ?? "";
    }
    const response = await fetcher(target, {
      method,
      headers,
      body: method === "GET" ? undefined : form ? body : JSON.stringify(body ?? {}),
      credentials: "include",
      cache: "no-store",
    });
    let data: Body = {};
    try {
      data = (await response.json()) as Body;
    } catch {
      data = {};
    }
    if (!response.ok) throw new ApiError(response.status, data);
    if (typeof data.csrf_token === "string") csrf = data.csrf_token;
    return data as T;
  }

  async function refreshCsrf() {
    const response = await fetcher(url("/csrf"), {
      credentials: "include",
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as Body;
    if (!response.ok) throw new ApiError(response.status, data);
    csrf = String(data.csrf_token);
  }

  return {
    get: <T = Body>(path: string, query?: Query) =>
      send<T>("GET", path, undefined, query),
    post: <T = Body>(path: string, body?: Body) => send<T>("POST", path, body),
    patch: <T = Body>(path: string, body?: Body) => send<T>("PATCH", path, body),
    upload: <T = Body>(path: string, form: FormData) => send<T>("POST", path, form),
    refreshCsrf,
    /** Run a call; if it needs a fresh passkey confirmation, get one and retry once. */
    async withPasskey<T>(call: () => Promise<T>, confirm: () => Promise<void>) {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "elevation_required") {
          throw error;
        }
        await confirm();
        return call();
      }
    },
  };
}

export type AdminApi = ReturnType<typeof createClient>;

export const api = createClient();

export type Page<T> = { results: T[]; page: number; pages: number; count: number };

/** Every page of a listing, for screens that reorder the whole list. */
export async function allPages<T>(path: string): Promise<T[]> {
  const first = await api.get<Page<T>>(path, { page: 1 });
  const rest = [];
  for (let page = 2; page <= first.pages; page++) {
    rest.push(api.get<Page<T>>(path, { page }));
  }
  return [first, ...(await Promise.all(rest))].flatMap((p) => p.results);
}
