// "Delete everything about this email": a vital action that waits 24 hours.
// The API stores counts and the choice, never the address; these helpers say
// what it stored in words.

import type { AdminApi } from "@/lib/admin/api";

export const ERASE_KIND = "erase_sender";

export const ERASE_WARNING =
  "Without 'also block', this also removes the block on this address if there is one.";

export type EraseTarget = {
  also_block: boolean;
  messages: number;
  notes: number;
  contacts: number;
};

export type Requested = {
  id: string;
  kind: string;
  target: EraseTarget;
  state: "waiting" | "ready";
  execute_after: string;
  expires_at: string;
};

type Origin = { message: string } | { contact: string };

export function eraseApi(client: AdminApi) {
  return {
    /** Needs a fresh passkey (wrap in vital()). */
    request: (from: Origin, alsoBlock: boolean) =>
      client.post<Requested>("/vital-actions/request", {
        kind: ERASE_KIND,
        payload: { ...from, also_block: alsoBlock },
      }),
  };
}

export type EraseApi = ReturnType<typeof eraseApi>;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True when a pending action's target has the shape erase_sender stores. */
export function isEraseTarget(target: unknown): target is EraseTarget {
  if (!target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  return (
    typeof t.also_block === "boolean" &&
    isCount(t.messages) &&
    isCount(t.notes) &&
    isCount(t.contacts)
  );
}

export function eraseCounts(target: EraseTarget): string {
  return `${count(target.messages, "message", "messages")}, ${count(
    target.notes,
    "note",
    "notes",
  )} and ${count(target.contacts, "saved contact", "saved contacts")}`;
}

export function eraseChoice(target: EraseTarget): string {
  return target.also_block
    ? "It will also keep the sender blocked."
    : "It will not keep the sender blocked, and any existing block on this address goes too.";
}

export const ERASE_TITLE = "Delete everything about one email address";

/** What was stored, for the owner to read. */
export function eraseSummary(target: EraseTarget): string {
  return `It will remove ${eraseCounts(target)}. ${eraseChoice(target)}`;
}

/** After asking: what the API stored and the wait. */
export function eraseRequested(target: EraseTarget): string {
  return `${eraseSummary(target)} It waits 24 hours and you can cancel it on the Pending actions page until it runs.`;
}
