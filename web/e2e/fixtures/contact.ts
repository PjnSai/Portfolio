import { createHash } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

// The API is on its own origin, as in production (see playwright.config.ts).
export const API = "http://localhost:8100";
export const SITE = "http://localhost:3100";

type Issued = {
  id: string;
  challenge: string;
  difficulty: number;
  started: string;
};

/** A number n so that SHA-256 of "<id>:<n>" starts with `bits` zero bits. */
export function solve(id: string, bits: number): string {
  for (let n = 0; ; n++) {
    const digest = createHash("sha256").update(`${id}:${n}`).digest();
    let zeros = 0;
    for (const byte of digest) {
      if (byte === 0) {
        zeros += 8;
        continue;
      }
      zeros += Math.clz32(byte) - 24;
      break;
    }
    if (zeros >= bits) return String(n);
  }
}

let counter = 0;

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

export async function challenge(request: APIRequestContext, address: string) {
  const response = await request.get(`${API}/api/v1/contact/challenge`, {
    headers: { "Cf-Connecting-Ip": address },
  });
  if (!response.ok()) throw new Error(`challenge: ${response.status()}`);
  return (await response.json()) as Issued;
}

export type Sent = {
  name: string;
  email: string;
  body: string;
  website?: string;
};

/**
 * Send a message through the real public route. `started` must be a form token
 * at least three seconds old (the first call's, kept), or the message is
 * quarantined as too fast.
 */
export async function sendMessage(
  request: APIRequestContext,
  started: string,
  message: Sent,
  address = nextAddress(),
) {
  const issued = await challenge(request, address);
  const response = await request.post(`${API}/api/v1/contact`, {
    headers: formHeaders(address),
    data: {
      website: "",
      ...message,
      started,
      challenge: issued.challenge,
      solution: solve(issued.id, issued.difficulty),
    },
  });
  return {
    status: response.status(),
    body: (await response.json()) as Record<string, unknown>,
  };
}
