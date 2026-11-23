// The owner's inbox: types, the rules the page mirrors from the API, and the
// calls it makes. The API decides everything; the page only avoids offering
// what it would refuse.

import type { AdminApi, Page } from "@/lib/admin/api";

export type MessageStatus = "new" | "read" | "replied" | "archived" | "spam";
export type Tab = "inbox" | MessageStatus;

export type MessageSummary = {
  id: string;
  name: string;
  email: string;
  status: MessageStatus;
  created_at: string;
  kept: boolean;
  snippet: string;
};

export type Counts = Record<MessageStatus, number>;
export type MessageList = Page<MessageSummary> & { counts: Counts };

export type NoteKind = "note" | "responded_with_details";
export type Note = {
  id: string;
  kind: NoteKind;
  text: string;
  created_at: string;
};

export type MessageDetail = {
  id: string;
  name: string;
  email: string;
  body: string;
  status: MessageStatus;
  created_at: string;
  read_at: string | null;
  kept: boolean;
  expires_at: string;
  notes: Note[];
};

export const NOTE_MAX = 2000;

export const TABS: readonly { tab: Tab; label: string }[] = [
  { tab: "inbox", label: "Inbox" },
  { tab: "new", label: "New" },
  { tab: "read", label: "Read" },
  { tab: "replied", label: "Replied" },
  { tab: "archived", label: "Archived" },
  { tab: "spam", label: "Spam" },
];

export const STATUS_LABEL: Record<MessageStatus, string> = {
  new: "New",
  read: "Read",
  replied: "Replied",
  archived: "Archived",
  spam: "Spam (held back)",
};

export const NOTE_LABEL: Record<NoteKind, string> = {
  note: "Note",
  responded_with_details: "Responded with details",
};

/** Moves the owner can make by hand; the same table as api/core/inbox.py. */
const MOVES: Record<MessageStatus, readonly MessageStatus[]> = {
  new: ["read", "replied", "archived", "spam"],
  read: ["new", "replied", "archived", "spam"],
  replied: ["read", "archived", "spam"],
  archived: ["new", "read", "replied", "spam"],
  spam: [],
};

export const MOVE_LABEL: Record<MessageStatus, string> = {
  new: "Mark as new",
  read: "Mark as read",
  replied: "Mark as replied",
  archived: "Archive",
  spam: "Mark as spam",
};

export function movesFrom(status: MessageStatus): readonly MessageStatus[] {
  return MOVES[status];
}

const ALL_STATUSES: readonly MessageStatus[] = [
  "new",
  "read",
  "replied",
  "archived",
  "spam",
];

export function isStatus(value: string | null): value is MessageStatus {
  return ALL_STATUSES.includes(value as MessageStatus);
}

/** The tab a query string asks for; anything unknown is the inbox. */
export function tabFrom(value: string | null): Tab {
  return isStatus(value) ? value : "inbox";
}

export function pageFrom(value: string | null): number {
  return value && /^[0-9]{1,6}$/.test(value) && Number(value) >= 1
    ? Number(value)
    : 1;
}

export function tabHref(base: string, tab: Tab, page = 1): string {
  const query = new URLSearchParams();
  if (tab !== "inbox") query.set("status", tab);
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

export function detailHref(
  base: string,
  id: string,
  tab: Tab,
  page: number,
): string {
  const query = new URLSearchParams({ id });
  if (tab !== "inbox") query.set("status", tab);
  if (page > 1) query.set("page", String(page));
  return `${base}?${query.toString()}`;
}

/** What a tab's count is: the inbox is everything except spam. */
export function tabCount(counts: Counts, tab: Tab): number {
  if (tab === "inbox")
    return counts.new + counts.read + counts.replied + counts.archived;
  return counts[tab];
}

/**
 * A reply in the owner's own mail client. Only the address and a fixed subject
 * go in the link: never any of the message. The address is encoded, so one
 * with ?, & or # in it cannot add a header.
 */
export function mailtoHref(email: string): string {
  const address = encodeURIComponent(email).replace(/%40/g, "@");
  return `mailto:${address}?subject=${encodeURIComponent("Re: your message")}`;
}

/** Calls against the inbox API. */
export function inboxApi(client: AdminApi) {
  return {
    list(tab: Tab, page: number) {
      return client.get<MessageList>("/messages", {
        status: tab === "inbox" ? undefined : tab,
        page: page > 1 ? page : undefined,
      });
    },
    open: (id: string) => client.get<MessageDetail>(`/messages/${id}`),
    setStatus: (id: string, status: MessageStatus) =>
      client.post<MessageDetail>(`/messages/${id}/status`, { status }),
    addNote: (id: string, text: string) =>
      client.post<Note>(`/messages/${id}/notes`, { text }),
    logResponse: (id: string, text: string) =>
      client.post<Note>(`/messages/${id}/responded`, text ? { text } : {}),
    setKept: (id: string, kept: boolean) =>
      client.post<MessageDetail>(`/messages/${id}/keep`, { kept }),
    notSpam: (id: string) =>
      client.post<MessageDetail>(`/messages/${id}/not-spam`),
    remove: (id: string) => client.post(`/messages/${id}/delete`),
  };
}

export type InboxApi = ReturnType<typeof inboxApi>;
