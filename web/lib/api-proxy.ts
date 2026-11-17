// The web service passes /api/v1/* through to the API service, so the admin
// pages and the API share one origin. Only the headers the API reads are sent
// on; anything else a client adds (Host, X-Forwarded-*, Authorization) is not.

const FORWARDED = [
  "accept",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-connecting-ip",
  "content-type",
  "origin",
  "sec-fetch-site",
  "x-csrf-token",
];

const NOT_RETURNED = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

export const MAX_BODY_BYTES = 1_000_000;

const MAX_PATH = 1024;

/** The API URL for a path under /api/v1, or null if it could leave /api/v1. */
export function upstreamUrl(
  base: string,
  segments: string[],
  search: string,
): string | null {
  // URL parsers treat "..", "." and their encoded forms as steps up a level,
  // so such segments are refused, and each other one is encoded on its own.
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const path = segments.map(encodeURIComponent).join("/");
  if (path.length + search.length > MAX_PATH) return null;
  return `${base.replace(/\/$/, "")}/api/v1/${path}${search}`;
}

export function forwardedHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export function returnedHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (name !== "set-cookie" && !NOT_RETURNED.has(name)) {
      headers.set(name, value);
    }
  });
  for (const cookie of upstream.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}
