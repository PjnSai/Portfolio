// Saved contacts: types, the limits the form mirrors from the API, the links
// between pages and the calls. The API decides everything; the page only avoids
// offering what it would refuse.

import type { AdminApi, Page } from "@/lib/admin/api";
import type { MessageSummary } from "@/lib/admin/inbox";

export type ContactSummary = {
  id: string;
  name: string;
  email: string;
  organisation: string;
  tags: string[];
  follow_up: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactDetail = ContactSummary & {
  notes: string;
  messages: MessageSummary[];
};

/** What the owner may set; the name and email come from the message. */
export type ContactFields = {
  organisation?: string;
  tags?: string[];
  notes?: string;
  follow_up?: string | null;
};

export const ORGANISATION_MAX = 100;
export const TAG_MAX = 30;
export const TAGS_MAX = 10;
export const NOTES_MAX = 5000;
export const SEARCH_MAX = 100;

export type ContactFilters = { q: string; tag: string; due: boolean };
export const NO_CONTACT_FILTERS: ContactFilters = { q: "", tag: "", due: false };

const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function contactPageFrom(value: string | null): number {
  return value && /^[0-9]{1,6}$/.test(value) && Number(value) >= 1
    ? Number(value)
    : 1;
}

/** The filters an address asks for. Anything not valid is dropped. */
export function contactFiltersFrom(
  get: (name: string) => string | null,
): ContactFilters {
  return {
    q: (get("q") ?? "").slice(0, SEARCH_MAX),
    tag: (get("tag") ?? "").slice(0, TAG_MAX),
    due: get("due") === "1",
  };
}

export function hasContactFilters(filters: ContactFilters): boolean {
  return Boolean(filters.q || filters.tag || filters.due);
}

function query(
  page: number,
  filters: ContactFilters,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams(extra);
  if (filters.q) params.set("q", filters.q);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.due) params.set("due", "1");
  if (page > 1) params.set("page", String(page));
  return params;
}

export function contactsHref(
  base: string,
  page = 1,
  filters: ContactFilters = NO_CONTACT_FILTERS,
): string {
  const search = query(page, filters).toString();
  return search ? `${base}?${search}` : base;
}

export function contactHref(
  base: string,
  id: string,
  page = 1,
  filters: ContactFilters = NO_CONTACT_FILTERS,
): string {
  return `${base}?${query(page, filters, { id }).toString()}`;
}

/** The message page's address for one message (ids ride in the query string). */
export function messageHref(base: string, id: string): string {
  return `${base}?${new URLSearchParams({ id }).toString()}`;
}

/** Tags typed as a list with commas: trimmed, empty ones dropped, each once. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export function tagsText(tags: readonly string[]): string {
  return tags.join(", ");
}

export type ContactForm = {
  organisation: string;
  tags: string;
  notes: string;
  followUp: string;
};

export type ContactErrors = Partial<Record<keyof ContactForm, string>>;

export function formFrom(contact?: ContactDetail | null): ContactForm {
  return {
    organisation: contact?.organisation ?? "",
    tags: tagsText(contact?.tags ?? []),
    notes: contact?.notes ?? "",
    followUp: contact?.follow_up ?? "",
  };
}

/** Checks the form and returns the fields to send, or the messages. */
export function checkContact(form: ContactForm): {
  errors: ContactErrors;
  fields: Required<ContactFields>;
} {
  const errors: ContactErrors = {};
  const organisation = form.organisation.trim();
  if (organisation.length > ORGANISATION_MAX || CONTROL.test(organisation)) {
    errors.organisation = `Keep the organisation to ${ORGANISATION_MAX} characters, on one line.`;
  }
  const tags = parseTags(form.tags);
  if (tags.length > TAGS_MAX) {
    errors.tags = `Use at most ${TAGS_MAX} tags.`;
  } else if (tags.some((tag) => tag.length > TAG_MAX)) {
    errors.tags = `Keep each tag to ${TAG_MAX} characters.`;
  }
  if (
    form.notes.length > NOTES_MAX ||
    CONTROL.test(form.notes.replace(/[\r\n\t]/g, ""))
  ) {
    errors.notes = `Keep the notes to ${NOTES_MAX} characters.`;
  }
  const day = form.followUp.trim();
  if (day) {
    const year = Number(day.slice(0, 4));
    const parsed = new Date(`${day}T00:00:00Z`);
    const real = DAY.test(day) && !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === day;
    if (!real || year < 2000 || year > 2099) {
      errors.followUp = "Choose a date from 2000 to 2099.";
    }
  }
  return {
    errors,
    fields: { organisation, tags, notes: form.notes, follow_up: day || null },
  };
}

/** Calls against the contacts API. */
export function contactsApi(client: AdminApi) {
  return {
    list(page: number, filters: ContactFilters = NO_CONTACT_FILTERS) {
      return client.get<Page<ContactSummary>>("/contacts", {
        q: filters.q.trim() || undefined,
        tag: filters.tag.trim() || undefined,
        due: filters.due ? "1" : undefined,
        page: page > 1 ? page : undefined,
      });
    },
    open: (id: string) => client.get<ContactDetail>(`/contacts/${id}`),
    createFromMessage: (message: string, fields: ContactFields = {}) =>
      client.post<ContactDetail>("/contacts", { message, ...fields }),
    edit: (id: string, fields: ContactFields) =>
      client.patch<ContactDetail>(`/contacts/${id}`, fields),
    link: (id: string, message: string) =>
      client.post<ContactDetail>(`/contacts/${id}/link`, { message }),
    unlink: (id: string, message: string) =>
      client.post<ContactDetail>(`/contacts/${id}/unlink`, { message }),
    /** Deleting a contact needs a fresh passkey; its messages stay. */
    remove: (id: string) =>
      client.post<{ deleted: boolean }>(`/contacts/${id}/delete`),
  };
}

export type ContactsApi = ReturnType<typeof contactsApi>;
