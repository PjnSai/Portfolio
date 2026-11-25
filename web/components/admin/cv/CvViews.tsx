import type { FormEvent } from "react";
import { PendingRow } from "@/components/admin/PendingRow";
import { Button, Card, FieldErrors, INPUT, Label, Pager } from "@/components/admin/ui";
import {
  type CvVersion,
  countryText,
  dayCountText,
  dayText,
  deleteBlocked,
  type DayCounts,
  kindText,
  pendingVersionDeletion,
  SWITCH_HELP,
  SWITCH_LABEL,
  SWITCH_NAMES,
  type SwitchName,
  type Switches,
  sizeText,
  UPLOAD_HINT,
  type ViewRow,
  versionFileHref,
} from "@/lib/admin/cv";
import { shortDate, timeLeft } from "@/lib/admin/time";

type Waiting = Parameters<typeof PendingRow>[0]["action"];

export function SwitchesCard({
  current,
  draft,
  pending,
  busy,
  now,
  onChange,
  onAsk,
  onCancel,
  onRun,
}: {
  current: Switches;
  draft: Switches;
  /** Waiting switch changes: the actions, as the API describes them. */
  pending: Waiting[];
  busy: boolean;
  now: Date;
  onChange: (name: SwitchName, value: boolean) => void;
  onAsk: () => void;
  onCancel: (action: Waiting) => void;
  onRun: (action: Waiting) => void;
}) {
  const changed = SWITCH_NAMES.some((name) => draft[name] !== current[name]);
  const locked = pending.length > 0;
  return (
    <section aria-labelledby="switches-title" className="mb-10">
      <h2 id="switches-title" className="mb-2 text-xl font-bold">
        Switches
      </h2>
      <p className="mb-4 text-muted">
        These decide what visitors can do. Changing them is a vital action: it asks for your passkey, waits 24 hours
        and can be cancelled until it runs. View-only stops casual saving, nothing more.
      </p>
      <Card>
        <ul className="mb-4 space-y-3">
          {SWITCH_NAMES.map((name) => (
            <li key={name}>
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  role="switch"
                  id={`switch-${name}`}
                  className="mt-1 h-5 w-5"
                  checked={draft[name]}
                  disabled={locked || busy}
                  onChange={(event) => onChange(name, event.target.checked)}
                />
                <span>
                  <span className="font-bold">{SWITCH_LABEL[name]}</span>
                  <span className="block text-sm text-muted">{SWITCH_HELP[name]}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {locked ? (
          <>
            <p className="mb-3 text-sm">
              A change is waiting. Cancel it, or wait for it to run, before asking for another.
            </p>
            <ul className="space-y-3">
              {pending.map((action) => (
                <PendingRow
                  key={action.id}
                  action={action}
                  now={now}
                  onCancel={() => onCancel(action)}
                  onRun={() => onRun(action)}
                />
              ))}
            </ul>
          </>
        ) : (
          <Button variant="primary" disabled={!changed || busy} onClick={onAsk}>
            Ask to change the switches
          </Button>
        )}
      </Card>
    </section>
  );
}

export function UploadCard({
  count,
  max,
  error,
  busy,
  hasFile,
  onFile,
  onSubmit,
}: {
  count: number;
  max: number;
  error: string;
  busy: boolean;
  hasFile: boolean;
  onFile: (file: File | null) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const full = count >= max;
  return (
    <form onSubmit={onSubmit} noValidate className="mb-6 space-y-3" aria-labelledby="upload-title">
      <h3 id="upload-title" className="text-lg font-bold">
        Upload a version
      </h3>
      <p className="text-sm text-muted">{UPLOAD_HINT}</p>
      <p className="text-sm" data-testid="cv-count">
        {count} of {max} versions in use.
        {full ? " Delete one before uploading another." : ""}
      </p>
      <label className="block">
        <Label>Choose a PDF (up to 5 MB)</Label>
        <input
          type="file"
          id="cv-file"
          className={INPUT}
          accept=".pdf,application/pdf"
          disabled={full || busy}
          aria-invalid={error ? true : undefined}
          aria-describedby="cv-file-error"
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
        <span id="cv-file-error">
          <FieldErrors messages={error ? [error] : []} />
        </span>
      </label>
      <Button type="submit" variant="primary" disabled={full || busy || !hasFile}>
        Upload
      </Button>
    </form>
  );
}

export function VersionRows({
  versions,
  pending,
  busy,
  now,
  onSetLive,
  onDelete,
  onCancelDelete,
}: {
  versions: CvVersion[];
  pending: Waiting[];
  busy: boolean;
  now: Date;
  onSetLive: (version: CvVersion) => void;
  onDelete: (version: CvVersion) => void;
  onCancelDelete: (action: Waiting) => void;
}) {
  if (versions.length === 0) return <p className="text-muted">No versions yet.</p>;
  return (
    <ul className="space-y-3">
      {versions.map((version) => {
        const deleting = pendingVersionDeletion(pending, version.id);
        const blocked = deleteBlocked(version);
        return (
          <li
            key={version.id}
            data-testid="cv-version"
            className="rounded-lg border border-line bg-panel p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold">
                {shortDate(version.created_at)} · {sizeText(version.size)}
              </p>
              {version.is_live ? (
                <span className="rounded-md border border-ink bg-ink px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-paper">
                  Live
                </span>
              ) : null}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted">SHA-256 {version.sha256}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {version.is_live ? null : (
                <Button disabled={busy} onClick={() => onSetLive(version)}>
                  Set live
                </Button>
              )}
              <a
                href={versionFileHref(version.id)}
                download
                className="inline-flex min-h-11 items-center rounded-md border border-line bg-panel px-4 py-2 text-sm font-semibold"
              >
                Download to attach
              </a>
              {blocked || deleting ? null : (
                <Button variant="danger" disabled={busy} onClick={() => onDelete(version)}>
                  Delete for good
                </Button>
              )}
            </div>
            {blocked ? <p className="mt-3 text-sm text-muted">{blocked}</p> : null}
            {blocked || deleting ? null : (
              <p className="mt-3 text-sm text-muted">
                Deleting asks for your passkey and waits 24 hours. You can cancel it until it runs.
              </p>
            )}
            {deleting ? (
              <div className="mt-3 text-sm">
                <p data-testid="cv-deleting">
                  Will be deleted for good after the 24-hour wait. Can run in{" "}
                  {timeLeft(deleting.execute_after, now).replace(" left", "")}.
                </p>
                <Button className="mt-2" variant="danger" disabled={busy} onClick={() => onCancelDelete(deleting)}>
                  Cancel deletion
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ViewLog({
  rows,
  page,
  pages,
  onPage,
}: {
  rows: ViewRow[];
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (rows.length === 0) return <p className="text-muted">Nobody has viewed or downloaded the CV yet.</p>;
  return (
    <>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.id} data-testid="cv-view-row" className="rounded-lg border border-line bg-panel p-4">
            <p className="font-bold">
              {kindText(row.kind)} · {shortDate(row.at)}
            </p>
            <p className="mt-1 text-sm">Country: {countryText(row.country)}</p>
            <p className="mt-1 break-all text-sm text-muted">{row.user_agent || "No browser name kept"}</p>
          </li>
        ))}
      </ul>
      <Pager page={page} pages={pages} onPage={onPage} />
    </>
  );
}

export function DayCountsList({ counts }: { counts: DayCounts }) {
  if (counts.days.length === 0) return <p className="text-muted">No visits have been counted yet.</p>;
  return (
    <>
      <p className="mb-3 text-sm">{counts.total} in all.</p>
      <ul className="space-y-1">
        {counts.days.map((day) => (
          <li key={day.day} data-testid="cv-day" className="flex flex-wrap justify-between gap-2">
            <span>{dayText(day.day)}</span>
            <span className="font-mono text-sm">{dayCountText(day)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
