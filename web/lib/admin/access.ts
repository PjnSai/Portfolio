// The access review: every principal that can touch the system (api/core/
// access_review.py). Only the fields listed here are kept, so a field added to
// the answer later is never shown by accident, and no secret can be.

import { z } from "zod";
import { checked } from "@/lib/admin/answer";
import type { AdminApi } from "@/lib/admin/api";

const when = z.string().nullable().optional();

const session = z.object({
  signed_in_at: z.string(),
  last_used: when,
  expires: z.string(),
  elevated_until: when,
  current: z.boolean(),
});

const passkey = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used: when,
});

const principal = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().optional(),
  can: z.array(z.string()),
  cannot: z.array(z.string()),
  credential: z.string(),
  expiry: z.string(),
  expires: when,
  last_used: when,
  checked_by_app: z.boolean(),
  revocable_here: z.boolean(),
  configured: z.boolean().optional(),
  connected_now: z.boolean().optional(),
  warning: z.string().nullable().optional(),
  note: z.string().optional(),
  items: z.array(z.union([session, passkey])).optional(),
});

const answer = z.object({ principals: z.array(principal).min(1) });

export type Principal = z.infer<typeof principal>;
export type SessionItem = z.infer<typeof session>;
export type PasskeyItem = z.infer<typeof passkey>;

export const isSession = (item: SessionItem | PasskeyItem): item is SessionItem =>
  "signed_in_at" in item;

export function hasSuperuserWarning(principals: readonly Principal[]): boolean {
  return principals.some((entry) => Boolean(entry.warning));
}

/** Where the owner's own sessions and passkeys are revoked. */
export const REVOKE_PATH = "/desk/security";
export const REVOKABLE_IN_APP = new Set(["owner_sessions", "owner_passkeys"]);

export function accessApi(client: AdminApi) {
  return {
    read: async () => checked(answer, await client.get("/access")).principals,
  };
}

export type AccessApi = ReturnType<typeof accessApi>;
