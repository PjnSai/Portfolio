import type { APIRequestContext } from "@playwright/test";

// The API is on its own origin, as in production (see playwright.config.ts).
export const API = "http://localhost:8100";
export const SITE = "http://localhost:3100";

/** Cloudflare's dummy token; the e2e API's stand-in accepts it once per suffix. */
const PASSES = "XXXX.DUMMY.TOKEN.XXXX";
let counter = 0;

export function turnstileToken(): string {
  counter += 1;
  return `${PASSES}#${Date.now().toString(36)}-${counter}`;
}

/** A fresh client address for each call, so the per-address limit is not met. */
export function nextAddress(): string {
  counter += 1;
  return `203.0.113.${(Date.now() + counter) % 250 || 1}`;
}

/** What a browser would send to the contact routes, from the site's origin. */
export function formHeaders(address: string) {
  return {
    Origin: SITE,
    "Sec-Fetch-Site": "same-site",
    "Cf-Connecting-Ip": address,
  };
}

/** The signed form-start token, as the form fetches it when it opens. */
export async function startForm(request: APIRequestContext, address: string) {
  const response = await request.get(`${API}/api/v1/contact/start`, {
    headers: { "Cf-Connecting-Ip": address },
  });
  if (!response.ok()) throw new Error(`start: ${response.status()}`);
  return ((await response.json()) as { started: string }).started;
}

export type Sent = {
  name: string;
  email: string;
  body: string;
  reason?: string;
  website?: string;
};

/**
 * Send a message through the real public route. `started` must be a form token
 * at least three seconds old, or the message is quarantined as too fast.
 */
export async function sendMessage(
  request: APIRequestContext,
  started: string,
  message: Sent,
  address = nextAddress(),
) {
  const response = await request.post(`${API}/api/v1/contact`, {
    headers: formHeaders(address),
    data: { website: "", ...message, started, turnstile: turnstileToken() },
  });
  return {
    status: response.status(),
    body: (await response.json()) as Record<string, unknown>,
  };
}
