import { Button, INPUT, Label, Notice } from "@/components/admin/ui";
import { type AbuseKind, type AbuseSummary, barPercent, KIND_WORDS, KINDS } from "@/lib/admin/abuse";
import { dayText } from "@/lib/admin/cv";

export function CountsOnlyNote() {
  return (
    <p className="mb-6 text-muted">
      These are counts only. They hold no addresses and no messages, so nothing here can say who was turned away or
      what they sent. Counts are kept for 365 days.
    </p>
  );
}

export function AbuseFilters({
  from,
  to,
  kind,
  error,
  busy,
  onChange,
  onSubmit,
}: {
  from: string;
  to: string;
  kind: AbuseKind | "";
  error: string;
  busy: boolean;
  onChange: (change: { from?: string; to?: string; kind?: AbuseKind | "" }) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      aria-label="Choose what to show"
      className="mb-8 grid gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <label htmlFor="abuse-from">
          <Label>From</Label>
        </label>
        <input
          id="abuse-from"
          type="date"
          className={INPUT}
          value={from}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "abuse-range-error" : undefined}
          onChange={(event) => onChange({ from: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor="abuse-to">
          <Label>To</Label>
        </label>
        <input
          id="abuse-to"
          type="date"
          className={INPUT}
          value={to}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "abuse-range-error" : undefined}
          onChange={(event) => onChange({ to: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor="abuse-kind">
          <Label>Kind</Label>
        </label>
        <select
          id="abuse-kind"
          className={INPUT}
          value={kind}
          onChange={(event) => onChange({ kind: event.target.value as AbuseKind | "" })}
        >
          <option value="">All kinds</option>
          {KINDS.map((each) => (
            <option key={each} value={each}>
              {KIND_WORDS[each].label}
            </option>
          ))}
        </select>
      </div>
      <Button variant="primary" type="submit" disabled={busy}>
        Show
      </Button>
      <div id="abuse-range-error" className="sm:col-span-4">
        <Notice kind="error">{error}</Notice>
      </div>
    </form>
  );
}

const total = (counts: Partial<Record<AbuseKind, number>>) =>
  Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

const HEAD = "py-2 pr-4 font-mono text-xs uppercase tracking-wide text-muted";

export function AbuseTotals({ summary }: { summary: AbuseSummary }) {
  return (
    <table className="mb-10 w-full text-sm" data-testid="abuse-totals">
      <caption className="mb-2 text-left text-xl font-bold">
        Totals, {dayText(summary.from)} to {dayText(summary.to)}
      </caption>
      <thead>
        <tr className="border-b-2 border-ink text-left">
          <th scope="col" className={HEAD}>
            Kind
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            Count
          </th>
          <th scope="col" className={`${HEAD} hidden sm:table-cell`}>
            What it means
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.kinds.map((kind) => (
          <tr key={kind} className="border-b border-line align-top" data-testid={`abuse-total-${kind}`}>
            <th scope="row" className="py-2 pr-4 text-left font-semibold">
              {KIND_WORDS[kind].label}
            </th>
            <td className="py-2 pr-4 text-right font-mono">{summary.totals[kind] ?? 0}</td>
            <td className="hidden py-2 text-muted sm:table-cell">{KIND_WORDS[kind].help}</td>
          </tr>
        ))}
        <tr className="border-b-2 border-ink">
          <th scope="row" className="py-2 pr-4 text-left font-extrabold">
            All kinds
          </th>
          <td className="py-2 pr-4 text-right font-mono font-bold" data-testid="abuse-total-all">
            {total(summary.totals)}
          </td>
          <td className="hidden sm:table-cell" />
        </tr>
      </tbody>
    </table>
  );
}

function breakdown(summary: AbuseSummary, counts: Partial<Record<AbuseKind, number>>): string {
  const parts = summary.kinds
    .filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => `${KIND_WORDS[kind].label} ${counts[kind]}`);
  return parts.length ? parts.join(", ") : "None";
}

export function AbuseDays({ summary }: { summary: AbuseSummary }) {
  const sums = summary.days.map((day) => total(day.counts));
  const busiest = Math.max(0, ...sums);
  return (
    <table className="w-full text-sm" data-testid="abuse-days">
      <caption className="mb-2 text-left text-xl font-bold">Counts by day (UTC)</caption>
      <thead>
        <tr className="border-b-2 border-ink text-left">
          <th scope="col" className={HEAD}>
            Day
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            Count
          </th>
          <th scope="col" className={`${HEAD} hidden w-1/4 sm:table-cell`}>
            Bar
          </th>
          <th scope="col" className={HEAD}>
            Of which
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.days.map((day, index) => {
          const percent = barPercent(sums[index], busiest);
          return (
            <tr key={day.day} data-testid="abuse-day" className="border-b border-line align-top">
              <th scope="row" className="whitespace-nowrap py-2 pr-4 text-left font-semibold">
                {dayText(day.day)}
              </th>
              <td className="py-2 pr-4 text-right font-mono">{sums[index]}</td>
              <td className="hidden py-2 pr-4 sm:table-cell">
                <svg aria-hidden="true" focusable="false" className="block h-3 w-full text-ink" height="12">
                  {percent > 0 && <rect x="0" y="0" height="12" width={`${percent}%`} fill="currentColor" />}
                </svg>
              </td>
              <td className="py-2 [overflow-wrap:anywhere]">{breakdown(summary, day.counts)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
