// The blocklist: types, the checks the forms mirror from the API, and the calls.

import type { AdminApi } from "@/lib/admin/api";
import type { MessageDetail } from "@/lib/admin/inbox";

export type BlockEntry = {
  id: string;
  /** Present only when the owner chose to keep the address, and while it blocks. */
  email: string | null;
  note: string;
  created_at: string;
  expires_at: string;
  hit_count: number;
  last_hit_at: string | null;
};

export type BlocklistListing = {
  entries: BlockEntry[];
  active: number;
  max_entries: number;
};

export type BlockOptions = { note: string; keepAddress: boolean };

export const BLOCK_NOTE_MAX = 200;
const EMAIL_MAX = 254;

/** The note's problem in words, or an empty string. */
export function checkNote(note: string): string {
  if (note.length > BLOCK_NOTE_MAX) {
    return `Keep the note to ${BLOCK_NOTE_MAX} characters.`;
  }
  if (note.includes("@")) return "Leave email addresses out of notes.";
  return "";
}

/** A quick check only; the API checks the address properly. */
export function checkBlockEmail(email: string): string {
  const value = email.trim();
  if (!value) return "Enter the email address to block.";
  if (
    value.length > EMAIL_MAX ||
    /\s/.test(value) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(value)
  ) {
    return "Enter a full email address.";
  }
  return "";
}

export function isBlocking(entry: BlockEntry, now: Date = new Date()): boolean {
  return new Date(entry.expires_at).getTime() > now.getTime();
}

export function sizeText(listing: BlocklistListing): string {
  return `${listing.active} of ${listing.max_entries} places in use`;
}

export function isFull(listing: BlocklistListing): boolean {
  return listing.active >= listing.max_entries;
}

function body({ note, keepAddress }: BlockOptions) {
  const text = note.trim();
  return { ...(text ? { note: text } : {}), keep_address: keepAddress };
}

export function blocklistApi(client: AdminApi) {
  return {
    list: () => client.get<BlocklistListing>("/blocklist"),
    add: (email: string, options: BlockOptions) =>
      client.post<BlockEntry>("/blocklist", {
        email: email.trim(),
        ...body(options),
      }),
    remove: (id: string) =>
      client.post<{ removed: boolean }>(`/blocklist/${id}/remove`),
    renew: (id: string) => client.post<BlockEntry>(`/blocklist/${id}/renew`),
    /** Blocks the sender and moves the message to spam. */
    blockMessage: (message: string, options: BlockOptions) =>
      client.post<{ entry: BlockEntry; message: MessageDetail }>(
        `/messages/${message}/block`,
        body(options),
      ),
  };
}

export type BlocklistApi = ReturnType<typeof blocklistApi>;
