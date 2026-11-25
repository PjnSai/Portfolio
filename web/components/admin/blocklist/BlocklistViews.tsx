import { FieldErrors, INPUT, Label, Button } from "@/components/admin/ui";
import {
  BLOCK_NOTE_MAX,
  type BlockEntry,
  type BlocklistListing,
  isBlocking,
  isFull,
  sizeText,
} from "@/lib/admin/blocklist";
import { shortDate } from "@/lib/admin/time";

/** The note and the keep-the-address tick, shared by the add form and the
 * message's Block sender form. The tick is off by default. */
export function BlockFields({
  prefix,
  note,
  keepAddress,
  noteError,
  onNote,
  onKeepAddress,
}: {
  prefix: string;
  note: string;
  keepAddress: boolean;
  noteError: string;
  onNote: (text: string) => void;
  onKeepAddress: (keep: boolean) => void;
}) {
  return (
    <>
      <label className="block">
        <Label>Note (optional, up to {BLOCK_NOTE_MAX} characters, no email addresses)</Label>
        <input
          id={`${prefix}-note`}
          className={INPUT}
          maxLength={BLOCK_NOTE_MAX}
          value={note}
          onChange={(event) => onNote(event.target.value)}
          aria-invalid={noteError ? true : undefined}
          aria-describedby={`${prefix}-note-error`}
        />
        <span id={`${prefix}-note-error`}>
          <FieldErrors messages={noteError ? [noteError] : []} />
        </span>
      </label>
      <label className="flex min-h-11 items-start gap-3">
        <input
          id={`${prefix}-keep`}
          type="checkbox"
          className="mt-1 h-5 w-5"
          checked={keepAddress}
          onChange={(event) => onKeepAddress(event.target.checked)}
        />
        <span>
          Keep the address so I can see it later
          <span className="block text-sm text-muted">
            Off by default: only a scrambled hash of the address is kept, and
            the list cannot show it. If you tick this, the address is stored
            with the entry and removed with it.
          </span>
        </span>
      </label>
    </>
  );
}

export function BlockSize({ listing }: { listing: BlocklistListing }) {
  return (
    <p data-testid="blocklist-size" className="mb-4">
      {sizeText(listing)}. Only entries that still block count.
      {isFull(listing) ? " The list is full: remove an entry before adding another." : ""}
    </p>
  );
}

function Stat({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-mono text-xs uppercase tracking-wide text-muted">{term}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export function BlockRows({
  entries,
  busy,
  now,
  onRenew,
  onRemove,
}: {
  entries: readonly BlockEntry[];
  busy: boolean;
  now?: Date;
  onRenew: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-muted">Nobody is blocked.</p>;
  }
  return (
    <ul className="space-y-3">
      {entries.map((entry) => {
        const blocking = isBlocking(entry, now);
        return (
          <li
            key={entry.id}
            data-testid="block-row"
            className="rounded-lg border border-line bg-panel p-4"
          >
            <p className="mb-2 font-bold [overflow-wrap:anywhere]">
              {entry.email ?? "Address not kept (scrambled hash only)"}
              {!blocking && (
                <span className="ml-2 rounded-md border border-line px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-muted">
                  Expired
                </span>
              )}
            </p>
            <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <Stat term="Note">{entry.note || "none"}</Stat>
              <Stat term="Added">{shortDate(entry.created_at)}</Stat>
              <Stat term={blocking ? "Blocks until" : "Expired"}>
                {shortDate(entry.expires_at)}
              </Stat>
              <Stat term="Messages stopped">{entry.hit_count}</Stat>
              <Stat term="Last stopped one">{shortDate(entry.last_hit_at)}</Stat>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => onRenew(entry.id)}>
                Renew
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => onRemove(entry.id)}>
                Remove
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AddBlockForm({
  email,
  note,
  keepAddress,
  errors,
  busy,
  full,
  onEmail,
  onNote,
  onKeepAddress,
  onSubmit,
}: {
  email: string;
  note: string;
  keepAddress: boolean;
  errors: { email: string; note: string };
  busy: boolean;
  full: boolean;
  onEmail: (text: string) => void;
  onNote: (text: string) => void;
  onKeepAddress: (keep: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label="Block an address"
      className="space-y-4 rounded-lg border border-line bg-panel p-4"
    >
      <label className="block">
        <Label>Email address to block</Label>
        <input
          id="block-email"
          type="email"
          className={INPUT}
          maxLength={254}
          autoComplete="off"
          value={email}
          onChange={(event) => onEmail(event.target.value)}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby="block-email-error"
        />
        <span id="block-email-error">
          <FieldErrors messages={errors.email ? [errors.email] : []} />
        </span>
      </label>
      <BlockFields
        prefix="add"
        note={note}
        keepAddress={keepAddress}
        noteError={errors.note}
        onNote={onNote}
        onKeepAddress={onKeepAddress}
      />
      <p className="text-sm text-muted">
        A blocked sender is told the message was received; nothing is stored.
        Adding asks for your passkey.
      </p>
      <Button type="submit" variant="primary" disabled={busy || full}>
        Block this address
      </Button>
    </form>
  );
}
