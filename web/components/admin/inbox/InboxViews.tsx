import Link from "next/link";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import {
  Button,
  FieldErrors,
  INPUT,
  Label,
  Pager,
} from "@/components/admin/ui";
import {
  type Counts,
  detailHref,
  type Filters,
  hasFilters,
  MOVE_LABEL,
  type MessageDetail,
  type MessageList,
  type MessageSummary,
  mailtoHref,
  movesFrom,
  NO_FILTERS,
  NOTE_LABEL,
  NOTE_MAX,
  REASON_LABEL,
  scoreLabel,
  STATUS_LABEL,
  type Tab,
  TABS,
  tabCount,
  tabHref,
} from "@/lib/admin/inbox";
import { shortDate, timeLeft } from "@/lib/admin/time";

/** Ids the page moves focus to after an action. */
export const FOCUS_IDS = {
  heading: "message-title",
  note: "note-text",
  delete: "delete-message",
  cancel: "delete-cancel",
  list: "list-title",
} as const;

function StatusChip({ status }: { status: MessageSummary["status"] }) {
  const tone =
    status === "spam" ? "border-danger text-danger" : "border-line text-ink";
  return (
    <span
      className={`rounded-md border px-2 py-0.5 font-mono text-xs uppercase tracking-wide ${tone}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The address the sender typed. No mail is ever sent to check it. */
function Unverified() {
  return (
    <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide text-muted">
      Unverified
    </span>
  );
}

export function InboxTabs({
  base,
  tab,
  counts,
  filters = NO_FILTERS,
}: {
  base: string;
  tab: Tab;
  counts: Counts | null;
  filters?: Filters;
}) {
  return (
    <nav aria-label="Message folders" className="mb-6">
      <ul className="flex flex-wrap gap-2">
        {TABS.map(({ tab: each, label }) => {
          const current = each === tab;
          return (
            <li key={each}>
              <Link
                href={tabHref(base, each, 1, filters)}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold ${
                  current
                    ? "border-ink bg-ink text-paper"
                    : "border-line bg-panel text-ink"
                }`}
              >
                {label}
                {counts && (
                  <span className="font-mono text-xs">
                    {tabCount(counts, each)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Search, reason and date range. Applying goes back to the first page. */
export function InboxFilters({
  filters,
  onApply,
}: {
  filters: Filters;
  onApply: (filters: Filters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const set = (name: keyof Filters, value: string) =>
    setDraft({ ...draft, [name]: value });
  const backwards = Boolean(
    draft.since && draft.until && draft.since > draft.until,
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (backwards) return;
    onApply({ ...draft, q: draft.q.trim() });
  }

  return (
    <form
      role="search"
      aria-label="Search and filter messages"
      onSubmit={submit}
      noValidate
      className="mb-6 grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <label className="block sm:col-span-2">
        <Label>Search name, email or message</Label>
        <input
          type="search"
          className={INPUT}
          maxLength={100}
          value={draft.q}
          onChange={(event) => set("q", event.target.value)}
        />
      </label>
      <label className="block">
        <Label>Reason</Label>
        <select
          className={INPUT}
          value={draft.reason}
          onChange={(event) => set("reason", event.target.value)}
        >
          <option value="">Any reason</option>
          <option value="hiring">{REASON_LABEL.hiring}</option>
          <option value="project">{REASON_LABEL.project}</option>
          <option value="other">{REASON_LABEL.other}</option>
          <option value="none">{REASON_LABEL.none}</option>
        </select>
      </label>
      <div className="hidden lg:block" />
      <label className="block">
        <Label>Received from</Label>
        <input
          type="date"
          className={INPUT}
          value={draft.since}
          onChange={(event) => set("since", event.target.value)}
        />
      </label>
      <label className="block">
        <Label>Received to</Label>
        <input
          type="date"
          className={INPUT}
          value={draft.until}
          onChange={(event) => set("until", event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
        <Button type="submit" variant="primary">
          Apply
        </Button>
        {hasFilters(filters) && (
          <Button
            onClick={() => {
              setDraft(NO_FILTERS);
              onApply(NO_FILTERS);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <div className="sm:col-span-2 lg:col-span-4">
        <FieldErrors
          messages={
            backwards ? ["The first day must not be after the last day."] : []
          }
        />
      </div>
    </form>
  );
}

const EMPTY: Record<Tab, string> = {
  inbox: "No messages yet.",
  new: "No new messages.",
  read: "No read messages.",
  replied: "No replied messages.",
  archived: "No archived messages.",
  spam: "Nothing has been held back.",
};

export function MessageRows({
  base,
  listing,
  tab,
  filters = NO_FILTERS,
  onPage,
}: {
  base: string;
  listing: MessageList;
  tab: Tab;
  filters?: Filters;
  onPage: (page: number) => void;
}) {
  if (listing.results.length === 0) {
    return (
      <p className="text-muted">
        {hasFilters(filters) ? "No messages match those filters." : EMPTY[tab]}
      </p>
    );
  }
  return (
    <>
      {tab === "spam" && (
        <p className="mb-4 text-muted">
          These were held back by the spam checks. Open one and choose Not spam
          if it is genuine.
        </p>
      )}
      <ul className="space-y-3">
        {listing.results.map((message) => (
          <li
            key={message.id}
            data-testid="message-row"
            className="rounded-lg border border-line bg-panel p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                href={detailHref(base, message.id, tab, listing.page, filters)}
                className="text-lg font-bold underline underline-offset-4"
              >
                {message.name}
              </Link>
              <StatusChip status={message.status} />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-2 break-all text-sm">
              {message.email} <Unverified />
            </p>
            <p className="mt-1 font-mono text-xs uppercase tracking-wide text-muted">
              {shortDate(message.created_at)}
              {message.reason ? ` · ${REASON_LABEL[message.reason]}` : ""}
              {" · "}
              {scoreLabel(message.spam_score)}
              {message.kept ? " · Kept" : ""}
            </p>
            <p className="mt-2 text-ink">{message.snippet}</p>
          </li>
        ))}
      </ul>
      <Pager page={listing.page} pages={listing.pages} onPage={onPage} />
    </>
  );
}

/** A deletion waiting out its 24 hours. */
export type Deletion = {
  state: "waiting" | "ready";
  executeAfter: string;
  expiresAt: string;
};

export type MessageViewProps = {
  message: MessageDetail;
  backHref: string;
  backLabel: string;
  pendingHref: string;
  busy: boolean;
  confirming: boolean;
  deletion: Deletion | null;
  now?: Date;
  noteText: string;
  noteError: string;
  onNoteText: (text: string) => void;
  onMove: (status: MessageDetail["status"]) => void;
  onAddNote: () => void;
  onLogResponse: () => void;
  onToggleKept: () => void;
  onNotSpam: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onRequestDelete: () => void;
  onCancelDeletion: () => void;
};

function retentionText(message: MessageDetail): string {
  if (message.kept) return "Kept: it stays until you delete it.";
  if (message.notes.length > 0)
    return "It has notes, so it stays until you delete it.";
  return `Ends ${shortDate(message.expires_at)}. Kept messages and messages with notes are exempt.`;
}

export function MessageView(props: MessageViewProps) {
  const { message, busy, confirming, deletion } = props;
  const spam = message.status === "spam";

  function submit(event: FormEvent) {
    event.preventDefault();
    props.onAddNote();
  }

  function keys(event: KeyboardEvent) {
    if (event.key === "Escape") props.onCancelDelete();
  }

  return (
    <article aria-labelledby={FOCUS_IDS.heading}>
      <p className="mb-4">
        <Link href={props.backHref} className="underline underline-offset-4">
          Back to {props.backLabel}
        </Link>
      </p>
      <h2
        id={FOCUS_IDS.heading}
        tabIndex={-1}
        className="mb-4 text-2xl font-extrabold tracking-tight"
      >
        Message from {message.name}
      </h2>

      {spam && (
        <p className="mb-4 rounded-md border-l-4 border-danger bg-panel px-4 py-3 text-sm">
          This message was held back by the spam checks. If it is genuine,
          choose Not spam to move it to the inbox.
        </p>
      )}

      <dl className="mb-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt>
            <Label>From</Label>
          </dt>
          <dd>{message.name}</dd>
        </div>
        <div>
          <dt>
            <Label>Email (UNVERIFIED)</Label>
          </dt>
          <dd className="break-all">{message.email}</dd>
        </div>
        <div>
          <dt>
            <Label>Received</Label>
          </dt>
          <dd>{shortDate(message.created_at)}</dd>
        </div>
        <div>
          <dt>
            <Label>Status</Label>
          </dt>
          <dd>
            <StatusChip status={message.status} />
          </dd>
        </div>
        <div>
          <dt>
            <Label>Reason</Label>
          </dt>
          <dd>{REASON_LABEL[message.reason || "none"]}</dd>
        </div>
        <div>
          <dt>
            <Label>Spam score</Label>
          </dt>
          <dd>{scoreLabel(message.spam_score)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt>
            <Label>Retention</Label>
          </dt>
          <dd>{retentionText(message)}</dd>
        </div>
      </dl>

      <section aria-labelledby="message-text" className="mb-6">
        <h3 id="message-text" className="mb-2 font-bold">
          Message
        </h3>
        <p className="whitespace-pre-wrap break-words rounded-lg border border-line bg-panel p-4">
          {message.body}
        </p>
      </section>

      <section aria-labelledby="message-actions" className="mb-6">
        <h3 id="message-actions" className="mb-2 font-bold">
          Actions
        </h3>
        <div className="flex flex-wrap gap-2">
          {!spam && (
            <a
              href={mailtoHref(message.email)}
              className="inline-flex min-h-11 items-center rounded-md border border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper"
            >
              Reply by email
            </a>
          )}
          {spam && (
            <Button variant="primary" disabled={busy} onClick={props.onNotSpam}>
              Not spam
            </Button>
          )}
          {movesFrom(message.status).map((status) => (
            <Button
              key={status}
              disabled={busy}
              onClick={() => props.onMove(status)}
            >
              {MOVE_LABEL[status]}
            </Button>
          ))}
          <Button
            disabled={busy}
            aria-pressed={message.kept}
            onClick={props.onToggleKept}
          >
            {message.kept ? "Kept: release it" : "Keep this message"}
          </Button>
          {!confirming && !deletion && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={props.onAskDelete}
              id={FOCUS_IDS.delete}
            >
              Delete for good
            </Button>
          )}
        </div>
        {confirming && (
          <div
            role="group"
            aria-labelledby="delete-title"
            onKeyDown={keys}
            className="mt-4 rounded-md border border-danger bg-panel p-4"
          >
            <p id="delete-title" className="font-bold">
              Delete this message for good?
            </p>
            <p className="mb-3 text-sm text-muted">
              This is a vital action. You will confirm with your passkey, then
              it waits 24 hours before it can run. You can cancel at any point
              until then. When it runs, the message and its notes are removed
              and cannot be recovered.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={props.onRequestDelete}
              >
                Request deletion
              </Button>
              <button
                type="button"
                id={FOCUS_IDS.cancel}
                className="min-h-11 rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink"
                onClick={props.onCancelDelete}
              >
                Keep it
              </button>
            </div>
          </div>
        )}
        {deletion && (
          <div
            role="group"
            aria-labelledby="pending-title"
            className="mt-4 rounded-md border-2 border-ink bg-panel p-4"
            data-testid="deletion-pending"
          >
            <p id="pending-title" className="font-bold">
              Deletion requested
            </p>
            <p className="mb-3 text-sm text-muted">
              {deletion.state === "waiting"
                ? `It can run in ${timeLeft(deletion.executeAfter, props.now).replace(" left", "")}.`
                : `It is ready to run and expires unused in ${timeLeft(deletion.expiresAt, props.now).replace(" left", "")}.`}{" "}
              Run it from{" "}
              <Link
                href={props.pendingHref}
                className="underline underline-offset-4"
              >
                Pending actions
              </Link>{" "}
              once it is ready. Until then the message stays as it is.
            </p>
            <Button
              variant="danger"
              disabled={busy}
              onClick={props.onCancelDeletion}
            >
              Cancel deletion
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="timeline-title" className="mb-6">
        <h3 id="timeline-title" className="mb-2 font-bold">
          Notes
        </h3>
        {message.notes.length === 0 ? (
          <p className="text-muted">No notes yet.</p>
        ) : (
          <ol className="space-y-3">
            {message.notes.map((note) => (
              <li
                key={note.id}
                data-testid="note"
                className="rounded-lg border border-line bg-panel p-3"
              >
                <p className="font-mono text-xs uppercase tracking-wide text-muted">
                  {NOTE_LABEL[note.kind]} · {shortDate(note.created_at)}
                </p>
                <p className="whitespace-pre-wrap break-words">{note.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <form onSubmit={submit} aria-labelledby="note-heading" noValidate>
        <h3 id="note-heading" className="mb-2 font-bold">
          Add to the notes
        </h3>
        <label htmlFor={FOCUS_IDS.note}>
          <Label>Note (for Log response it is optional)</Label>
        </label>
        <textarea
          id={FOCUS_IDS.note}
          rows={4}
          maxLength={NOTE_MAX}
          value={props.noteText}
          onChange={(event) => props.onNoteText(event.target.value)}
          aria-describedby="note-hint note-error"
          aria-invalid={props.noteError ? true : undefined}
          className={INPUT}
        />
        <span id="note-hint" className="mt-1 block text-sm text-muted">
          Up to {NOTE_MAX.toLocaleString("en-GB")} characters. Notes cannot be
          edited or removed.
        </span>
        <span id="note-error">
          <FieldErrors messages={props.noteError ? [props.noteError] : []} />
        </span>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            Add note
          </Button>
          {!spam && (
            <Button disabled={busy} onClick={props.onLogResponse}>
              Log response
            </Button>
          )}
        </div>
      </form>
    </article>
  );
}
