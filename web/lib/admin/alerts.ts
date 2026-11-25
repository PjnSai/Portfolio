// Alerts the API records for the owner (api/core/alerts.py). They are shown in
// the admin only; a notice outside the site is separate.

import { z } from "zod";
import { checked } from "@/lib/admin/answer";
import type { AdminApi } from "@/lib/admin/api";

const KIND_WORDS: Record<string, string> = {
  failed_sign_ins: "Failed sign-ins",
  passkey_added: "Passkey added",
  vital_action_requested: "Vital action requested",
  rate_limit_storm: "Many requests turned away",
  error_spike: "Server errors",
};

export function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? "Other alert";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const alert = z.object({
  id: z.string().regex(UUID),
  at: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string(),
  seen: z.boolean(),
});

const list = z.object({
  alerts: z.array(alert),
  next_before: z.string().regex(UUID).nullable(),
  unseen: z.number().int().min(0),
});

export type Alert = z.infer<typeof alert>;
export type AlertList = z.infer<typeof list>;
export type AlertQuery = { unseenOnly?: boolean; before?: string; limit?: number };

/** How many alerts the page asks for at a time. */
export const PAGE_SIZE = 20;

export function alertsApi(client: AdminApi) {
  return {
    list: async ({ unseenOnly, before, limit }: AlertQuery) =>
      checked(
        list,
        await client.get("/alerts", { unseen: unseenOnly ? 1 : undefined, before, limit }),
      ),
    /** The unseen count, through the smallest page. */
    count: async () => checked(list, await client.get("/alerts", { limit: 1 })).unseen,
    markSeen: async (id: string) => {
      if (!UUID.test(id)) throw new Error("Not an alert id.");
      return checked(alert, await client.post(`/alerts/${id}/seen`));
    },
  };
}

export type AlertsApi = ReturnType<typeof alertsApi>;
