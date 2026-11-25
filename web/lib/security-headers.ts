// The web app's security headers, for every page of the static export.
// scripts/write-headers.ts puts them in out/_headers after each build, where
// Cloudflare Pages (and scripts/serve-static.ts locally) apply them.
// No imports: the build scripts load this file with Node directly.

/**
 * Hashes of inline scripts written by hand, added to every page's policy:
 * the palette and theme script in lib/public/boot-script.ts.
 * tests/boot-script.test.ts recomputes it from the script's text.
 */
export const EXTRA_SCRIPT_HASHES: readonly string[] = [
  "sha256-iLkgYOgBGRnwpkbNeWMeKqjOGGejjapiacMzHigcCpY=",
];

/**
 * The colour picker in the palette editor (react-colorful) adds one fixed
 * <style> element when it first renders. Its hash is allowed on admin pages
 * only; tests/security-headers.test.ts recomputes it from the installed package,
 * so an upgrade that changes the CSS fails the tests until this is updated.
 */
export const ADMIN_STYLE_HASHES: readonly string[] = [
  "sha256-I2px+fnpbN4E5+Djrj7aoTIyq9yyREkuVl19f4Sye9A=",
];

/**
 * The one third-party origin, for the one page that holds the contact form:
 * Cloudflare Turnstile's script and its frame, as Cloudflare documents
 * (developers.cloudflare.com/turnstile/reference/content-security-policy).
 * Its connect-src entry is only for pre-clearance, which is not used.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Present in a built page's HTML if, and only if, it carries the contact form. */
export const CONTACT_FORM_MARKER = "data-contact-form";

/**
 * Present in a built page's HTML if, and only if, it carries the CV block, which
 * uses Turnstile and the API in the same way as the contact form.
 */
export const CV_BLOCK_MARKER = "data-cv-block";

export type PolicyInput = {
  /** "sha256-<base64>" for each inline script on the page. */
  scripts: readonly string[];
  /** "sha256-<base64>" for each inline style element on the page. */
  styles: readonly string[];
  /** The API origin, or "" if there is none. */
  api: string;
  /** Admin pages call the API from the browser; public pages only show its images. */
  admin: boolean;
  /**
   * The page carries the contact form: it may load Turnstile's script and
   * frame, and send the message to the API. No other page gets either.
   */
  form?: boolean;
};

const quoted = (hashes: readonly string[]) => hashes.map((h) => ` '${h}'`).join("");

/**
 * Scripts and styles run only from this site or if their hash is listed: no
 * nonce, so pages can be static and cached, and no 'unsafe-inline' or 'unsafe-eval'.
 */
export function contentSecurityPolicy(input: PolicyInput): string {
  const api = input.api ? ` ${input.api}` : "";
  const form = input.form === true;
  const scripts = [...new Set([...EXTRA_SCRIPT_HASHES, ...input.scripts])].sort();
  const styles = [...new Set([...(input.admin ? ADMIN_STYLE_HASHES : []), ...input.styles])].sort();
  return [
    "default-src 'self'",
    `script-src 'self'${quoted(scripts)}${form ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    `style-src 'self'${quoted(styles)}`,
    `img-src 'self' data:${api}`,
    "font-src 'self'",
    `connect-src 'self'${input.admin || form ? api : ""}`,
    ...(form ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
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

/**
 * Public pages, with the published palettes written into them: any cache may
 * keep a copy but must check it first (Pages answers with an ETag), so a new
 * build after Publish is seen on the next page load.
 */
export const PAGE_CACHE = "public, max-age=0, must-revalidate";

/** Built files under /_next/static have content hashes in their names. */
export const ASSET_CACHE = "public, max-age=31536000, immutable";
