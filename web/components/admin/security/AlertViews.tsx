import { Button } from "@/components/admin/ui";
import { type Alert, kindWords } from "@/lib/admin/alerts";
import { shortDate } from "@/lib/admin/time";

export function AlertsNote() {
  return (
    <p className="mb-6 text-muted">
      These alerts are kept only in this admin. A notice outside the site is separate: for now it goes to the
      server log, and email will be added once an email service is chosen. Marking an alert seen changes nothing
      else.
    </p>
  );
}

export function AlertFilter({
  unseenOnly,
  onChange,
}: {
  unseenOnly: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="mb-6 flex min-h-11 items-center gap-3">
      <input
        id="alerts-unseen-only"
        type="checkbox"
        className="h-5 w-5"
        checked={unseenOnly}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Unseen only</span>
    </label>
  );
}

/** The count on the Alerts link: nothing for none, a question mark if it could not be read. */
export function UnseenBadge({ count }: { count: number | null }) {
  if (count === 0) return null;
  return (
    <span
      data-testid="alerts-count"
      className="ml-1 inline-block min-w-5 rounded-md bg-ink px-1.5 text-center font-mono text-xs font-bold text-paper"
    >
      <span aria-hidden="true">{count === null ? "?" : count}</span>
      <span className="sr-only">
        {count === null ? " (the unseen count could not be checked)" : ` (${count} unseen)`}
      </span>
    </span>
  );
}

export function AlertRows({
  alerts,
  busyId,
  onSeen,
}: {
  alerts: Alert[];
  busyId: string | null;
  onSeen: (alert: Alert) => void;
}) {
  return (
    <ol className="divide-y divide-line rounded-lg border border-line bg-panel">
      {alerts.map((alert) => (
        <li
          key={alert.id}
          id={`alert-${alert.id}`}
          tabIndex={-1}
          data-testid="alert"
          data-seen={alert.seen ? "true" : "false"}
          className="flex flex-wrap items-start justify-between gap-3 p-4 outline-offset-2"
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs uppercase tracking-wide text-muted">
              <time dateTime={alert.at}>{shortDate(alert.at)}</time> · {alert.seen ? "Seen" : "Unseen"}
            </p>
            <p className="font-bold">{kindWords(alert.kind)}</p>
            <p id={`alert-summary-${alert.id}`} className="[overflow-wrap:anywhere]">
              {alert.summary}
            </p>
          </div>
          {!alert.seen && (
            <Button
              disabled={busyId === alert.id}
              aria-describedby={`alert-summary-${alert.id}`}
              onClick={() => onSeen(alert)}
            >
              Mark seen
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}
