// The web service's security headers. This is the only place they are defined;
// proxy.ts applies them to every response.

/** 128 random bits, new for every request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Scripts and styles run only if they carry this request's nonce. There is no
 * 'unsafe-inline', and 'unsafe-eval' is allowed only by the development server,
 * which React needs for its debugging tools.
 */
export function contentSecurityPolicy(
  nonce: string,
  development = false,
): string {
  const script = development ? " 'unsafe-eval'" : "";
  const style = development ? "'unsafe-inline'" : `'nonce-${nonce}'`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${script}`,
    `style-src 'self' ${style}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
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

export function securityHeaders(
  nonce: string,
  development = false,
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(nonce, development),
    ...STATIC_HEADERS,
  };
}
