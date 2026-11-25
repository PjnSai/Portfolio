import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Button, FieldErrors, INPUT, Label, Pager } from "@/components/admin/ui";
import type { Page } from "@/lib/admin/api";
import {
  type ContactDetail,
  type ContactErrors,
  type ContactFilters,
  type ContactForm,
  type ContactSummary,
  contactHref,
  hasContactFilters,
  messageHref,
  NO_CONTACT_FILTERS,
  NOTES_MAX,
  ORGANISATION_MAX,
  SEARCH_MAX,
  TAG_MAX,
  TAGS_MAX,
} from "@/lib/admin/contacts";
import { type MessageSummary, STATUS_LABEL } from "@/lib/admin/inbox";
import { shortDate } from "@/lib/admin/time";

/** A day as the owner reads it, from a YYYY-MM-DD string. */
export function dayText(day: string | null): string {
  if (!day) return "none set";
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(+parsed)
    ? day
    : parsed.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

/** True when the follow-up day has come (today or earlier, UTC). */
export function isDue(day: string | null, now: Date = new Date()): boolean {
  return day !== null && day <= now.toISOString().slice(0, 10);
}

export function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Tags">
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-md border border-line px-2 py-0.5 font-mono text-xs uppercase tracking-wide"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}

export function ContactFilterForm({
  filters,
  onApply,
}: {
  filters: ContactFilters;
  onApply: (filters: ContactFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);

  function submit(event: FormEvent) {
    event.preventDefault();
    onApply({ ...draft, q: draft.q.trim(), tag: draft.tag.trim() });
  }

  return (
    <form
      role="search"
      aria-label="Search and filter contacts"
      onSubmit={submit}
      noValidate
      className="mb-6 grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-2"
    >
      <label className="block">
        <Label>Search name, organisation or email</Label>
        <input
          type="search"
          className={INPUT}
          maxLength={SEARCH_MAX}
          value={draft.q}
          onChange={(event) => setDraft({ ...draft, q: event.target.value })}
        />
      </label>
      <label className="block">
        <Label>Tag</Label>
        <input
          className={INPUT}
          maxLength={TAG_MAX}
          value={draft.tag}
          onChange={(event) => setDraft({ ...draft, tag: event.target.value })}
        />
      </label>
      <label className="flex min-h-11 items-center gap-3 sm:col-span-2">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={draft.due}
          onChange={(event) => setDraft({ ...draft, due: event.target.checked })}
        />
        <span>Follow-up due (today or earlier)</span>
      </label>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
        <Button type="submit" variant="primary">
          Apply
        </Button>
        {hasContactFilters(filters) && (
          <Button
            onClick={() => {
              setDraft(NO_CONTACT_FILTERS);
              onApply(NO_CONTACT_FILTERS);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    </form>
  );
}

export function ContactRows({
  base,
  listing,
  filters = NO_CONTACT_FILTERS,
  onPage,
  now,
}: {
  base: string;
  listing: Page<ContactSummary>;
  filters?: ContactFilters;
  onPage: (page: number) => void;
  now?: Date;
}) {
  if (listing.results.length === 0) {
    return (
      <p className="text-muted">
        {hasContactFilters(filters)
          ? "No contacts match those filters."
          : "No saved contacts yet. Open a message and choose Save as contact."}
      </p>
    );
  }
  return (
    <>
      <ul className="space-y-3">
        {listing.results.map((contact) => (
          <li
            key={contact.id}
            data-testid="contact-row"
            className="rounded-lg border border-line bg-panel p-4"
          >
            <Link
              href={contactHref(base, contact.id, listing.page, filters)}
              className="text-lg font-bold underline underline-offset-4 [overflow-wrap:anywhere]"
            >
              {contact.name}
            </Link>
            <p className="mt-1 break-all text-sm">
              {contact.organisation ? `${contact.organisation} · ` : ""}
              {contact.email}
            </p>
            <div className="mt-2">
              <TagList tags={contact.tags} />
            </div>
            {contact.follow_up && (
              <p className="mt-2 font-mono text-xs uppercase tracking-wide text-muted">
                Follow up {dayText(contact.follow_up)}
                {isDue(contact.follow_up, now) ? " · due" : ""}
              </p>
            )}
          </li>
        ))}
      </ul>
      <Pager page={listing.page} pages={listing.pages} onPage={onPage} />
    </>
  );
}

/** The fields the owner can set on a contact, for creating and for editing. */
export function ContactFields({
  prefix,
  form,
  errors,
  onChange,
}: {
  prefix: string;
  form: ContactForm;
  errors: ContactErrors;
  onChange: (name: keyof ContactForm, value: string) => void;
}) {
  const field = (name: keyof ContactForm) => ({
    id: `${prefix}-${name}`,
    "aria-invalid": errors[name] ? (true as const) : undefined,
    "aria-describedby": `${prefix}-${name}-error`,
  });
  const problem = (name: keyof ContactForm) => (
    <span id={`${prefix}-${name}-error`}>
      <FieldErrors messages={errors[name] ? [errors[name]] : []} />
    </span>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block">
        <Label>Organisation (optional)</Label>
        <input
          className={INPUT}
          maxLength={ORGANISATION_MAX}
          value={form.organisation}
          onChange={(event) => onChange("organisation", event.target.value)}
          {...field("organisation")}
        />
        {problem("organisation")}
      </label>
      <label className="block">
        <Label>Tags (optional, separated by commas, up to {TAGS_MAX})</Label>
        <input
          className={INPUT}
          value={form.tags}
          onChange={(event) => onChange("tags", event.target.value)}
          {...field("tags")}
        />
        {problem("tags")}
      </label>
      <label className="block sm:col-span-2">
        <Label>Notes (optional, private)</Label>
        <textarea
          className={`${INPUT} min-h-32`}
          maxLength={NOTES_MAX}
          value={form.notes}
          onChange={(event) => onChange("notes", event.target.value)}
          {...field("notes")}
        />
        {problem("notes")}
      </label>
      <label className="block">
        <Label>Follow-up date (optional)</Label>
        <input
          type="date"
          className={INPUT}
          min="2000-01-01"
          max="2099-12-31"
          value={form.followUp}
          onChange={(event) => onChange("followUp", event.target.value)}
          {...field("followUp")}
        />
        {problem("followUp")}
      </label>
    </div>
  );
}

/** The linked messages, each with a link to it and a way to unlink it. */
export function LinkedMessages({
  messageBase,
  messages,
  busy,
  onUnlink,
}: {
  messageBase: string;
  messages: readonly MessageSummary[];
  busy: boolean;
  onUnlink: (id: string) => void;
}) {
  if (messages.length === 0) {
    return <p className="text-muted">No messages are linked to this contact.</p>;
  }
  return (
    <ul className="space-y-3" aria-label="Linked messages">
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid="linked-message"
          className="rounded-lg border border-line bg-panel p-4"
        >
          <p className="font-mono text-xs uppercase tracking-wide text-muted">
            {shortDate(message.created_at)} · {STATUS_LABEL[message.status]}
          </p>
          <p className="my-2 [overflow-wrap:anywhere]">{message.snippet}</p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={messageHref(messageBase, message.id)}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Open this message
            </Link>
            <Button disabled={busy} onClick={() => onUnlink(message.id)}>
              Unlink this message
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Messages from the same sender that are not linked yet. */
export function LinkableMessages({
  messageBase,
  messages,
  busy,
  onLink,
}: {
  messageBase: string;
  messages: readonly MessageSummary[] | null;
  busy: boolean;
  onLink: (id: string) => void;
}) {
  if (messages === null) return <p className="text-muted">Looking for messages…</p>;
  if (messages.length === 0) {
    return (
      <p className="text-muted">
        No other messages from this sender are waiting to be linked.
      </p>
    );
  }
  return (
    <ul className="space-y-3" aria-label="Messages that can be linked">
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid="linkable-message"
          className="rounded-lg border border-line bg-panel p-4"
        >
          <p className="font-mono text-xs uppercase tracking-wide text-muted">
            {shortDate(message.created_at)} · {STATUS_LABEL[message.status]}
          </p>
          <p className="my-2 [overflow-wrap:anywhere]">{message.snippet}</p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={messageHref(messageBase, message.id)}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Open this message
            </Link>
            <Button disabled={busy} onClick={() => onLink(message.id)}>
              Link this message
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The read-only part of a contact: name, email, and when it was made. */
export function ContactIdentity({ contact }: { contact: ContactDetail }) {
  return (
    <dl className="mb-6 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
      <dt className="font-mono text-xs uppercase tracking-wide text-muted">Name</dt>
      <dd className="[overflow-wrap:anywhere]">{contact.name}</dd>
      <dt className="font-mono text-xs uppercase tracking-wide text-muted">
        Email (cannot be changed)
      </dt>
      <dd className="break-all">{contact.email}</dd>
      <dt className="font-mono text-xs uppercase tracking-wide text-muted">Saved</dt>
      <dd>{shortDate(contact.created_at)}</dd>
      <dt className="font-mono text-xs uppercase tracking-wide text-muted">
        Follow-up
      </dt>
      <dd>
        {dayText(contact.follow_up)}
        {isDue(contact.follow_up) ? " (due)" : ""}
      </dd>
    </dl>
  );
}
