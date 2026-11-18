// The API's origin, fixed at build time. The public pages read the site from
// it while building; the admin pages call it from the browser. It is a public
// address, not a secret.

/** The origin from API_BASE_URL, or "" when unset. Anything but an origin is refused. */
export function apiOrigin(raw: string | undefined): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API_BASE_URL is not a URL.");
  }
  const local = url.protocol === "http:" && url.hostname === "localhost";
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new Error("API_BASE_URL must be https (or http://localhost for tests).");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("API_BASE_URL must be an origin with no path.");
  }
  return url.origin;
}

/** Where the browser finds the API (inlined by next.config). */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
