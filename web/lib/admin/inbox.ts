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
  reason: "" | Reason;
  spam_score: number;
  created_at: string;
  kept: boolean;
  contact_id: string | null;
  snippet: string;
};

export type Reason = "hiring" | "project" | "other";

export const REASON_LABEL: Record<Reason | "none", string> = {
  hiring: "Hiring",
  project: "Project",
  other: "Other",
  none: "No reason given",
};

/** The narrowing the list page offers, as it sits in the address. */
export type Filters = {
  q: string;
  reason: "" | Reason | "none";
  since: string;
  until: string;
};

export const NO_FILTERS: Filters = { q: "", reason: "", since: "", until: "" };

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
  reason: "" | Reason;
  spam_score: number;
  status: MessageStatus;
  created_at: string;
  read_at: string | null;
  kept: boolean;
  contact_id: string | null;
  expires_at: string;
  notes: Note[];
};

export type Retention = {
  spam_days: number;
  message_days: number;
  min_days: number;
  max_days: number;
};

export const NOTE_MAX = 2000;

/** A pending deletion of this message, from the list of waiting vital actions. */
export function pendingDeletion<
  T extends { kind: string; target: Record<string, string | number | boolean> },
>(pending: readonly T[], id: string): T | undefined {
  return pending.find(
    (action) =>
      action.kind === "permanent_delete" &&
      action.target.entity === "message" &&
      action.target.id === id,
  );
}

/** The spam score in words, for people who cannot see a gauge. */
export function scoreLabel(score: number): string {
  return `Spam score ${score} of 100`;
}

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

function query(
  tab: Tab,
  page: number,
  filters: Filters,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams(extra);
  if (tab !== "inbox") params.set("status", tab);
  if (filters.q) params.set("q", filters.q);
  if (filters.reason) params.set("reason", filters.reason);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (page > 1) params.set("page", String(page));
  return params;
}

export function tabHref(
  base: string,
  tab: Tab,
  page = 1,
  filters: Filters = NO_FILTERS,
): string {
  const search = query(tab, page, filters).toString();
  return search ? `${base}?${search}` : base;
}

export function detailHref(
  base: string,
  id: string,
  tab: Tab,
  page: number,
  filters: Filters = NO_FILTERS,
): string {
  return `${base}?${query(tab, page, filters, { id }).toString()}`;
}

const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The filters an address asks for. Anything not valid is dropped, never sent on. */
export function filtersFrom(get: (name: string) => string | null): Filters {
  const reason = get("reason");
  const day = (name: string) => {
    const value = get(name) ?? "";
    return DAY.test(value) ? value : "";
  };
  return {
    q: (get("q") ?? "").slice(0, 100),
    reason:
      reason === "hiring" ||
      reason === "project" ||
      reason === "other" ||
      reason === "none"
        ? reason
        : "",
    since: day("since"),
    until: day("until"),
  };
}

export function hasFilters(filters: Filters): boolean {
  return Boolean(filters.q || filters.reason || filters.since || filters.until);
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
    list(tab: Tab, page: number, filters: Filters = NO_FILTERS) {
      return client.get<MessageList>("/messages", {
        status: tab === "inbox" ? undefined : tab,
        q: filters.q.trim() || undefined,
        reason: filters.reason || undefined,
        since: filters.since || undefined,
        until: filters.until || undefined,
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
    /** Deletion is a vital action: it needs a fresh passkey and waits 24 hours. */
    requestDelete: (id: string) =>
      client.post("/vital-actions/request", {
        kind: "permanent_delete",
        payload: { entity: "message", id },
      }),
    retention: () => client.get<Retention>("/retention"),
    saveRetention: (spam_days: number, message_days: number) =>
      client.patch<Retention>("/retention", { spam_days, message_days }),
  };
}

export type InboxApi = ReturnType<typeof inboxApi>;
