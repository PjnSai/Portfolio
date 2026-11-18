// The web app's security headers, for every page of the static export.
// scripts/write-headers.ts puts them in out/_headers after each build, where
// Cloudflare Pages (and scripts/serve-static.ts locally) apply them.
// No imports: the build scripts load this file with Node directly.

/**
 * Hashes of inline scripts written by hand, added to every page's policy.
 * Empty for now; phase 3A-4 adds one here (format "sha256-<base64>").
 */
export const EXTRA_SCRIPT_HASHES: readonly string[] = [];

export type PolicyInput = {
  /** "sha256-<base64>" for each inline script on the page. */
  scripts: readonly string[];
  /** "sha256-<base64>" for each inline style element on the page. */
  styles: readonly string[];
  /** The API origin, or "" if there is none. */
  api: string;
  /** Admin pages call the API from the browser; public pages only show its images. */
  admin: boolean;
};

const quoted = (hashes: readonly string[]) => hashes.map((h) => ` '${h}'`).join("");

/**
 * Scripts and styles run only from this site or if their hash is listed: no
 * nonce, so pages can be static and cached, and no 'unsafe-inline' or 'unsafe-eval'.
 */
export function contentSecurityPolicy(input: PolicyInput): string {
  const api = input.api ? ` ${input.api}` : "";
  const scripts = [...new Set([...EXTRA_SCRIPT_HASHES, ...input.scripts])].sort();
  const styles = [...new Set(input.styles)].sort();
  return [
    "default-src 'self'",
    `script-src 'self'${quoted(scripts)}`,
    `style-src 'self'${quoted(styles)}`,
    `img-src 'self' data:${api}`,
    "font-src 'self'",
    `connect-src 'self'${input.admin ? api : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const STATIC_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), " +
    "magnetometer=(), microphone=(), payment=(), usb=()",
};

/** The admin pages: never indexed, never cached. Cloudflare Access guards them. */
export const ADMIN_PATH = "/desk";

export function isPrivatePath(pathname: string): boolean {
  return pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);
}

export const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

/** Built files under /_next/static have content hashes in their names. */
export const ASSET_CACHE = "public, max-age=31536000, immutable";
