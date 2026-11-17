"use client";

import { useCallback, useState } from "react";
import { Button, Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Entry = {
  seq: number;
  at: string;
  event: string;
  actor: string;
  detail: Record<string, unknown>;
  flagged: boolean;
};

type Listing = { entries: Entry[]; next_before: number | null };

const PAGE = 50;

export default function Audit() {
  const [flagged, setFlagged] = useState(false);
  const [check, setCheck] = useState("");

  async function verify() {
    setCheck("");
    try {
      const result = await api.get<{ ok: boolean; entries: number; first_bad_seq: number }>(
        "/audit/verify",
      );
      setCheck(
        result.ok
          ? `All ${result.entries} entries are intact.`
          : `The log has been changed at entry ${result.first_bad_seq}.`,
      );
    } catch (failure) {
      setCheck(describeError(failure));
    }
  }

  return (
    <>
      <PageTitle>Audit log</PageTitle>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-5"
            checked={flagged}
            onChange={(e) => setFlagged(e.target.checked)}
          />
          Flagged security events only
        </label>
        <Button onClick={verify}>Check the log is intact</Button>
      </div>
      <Notice>{check}</Notice>
      <Entries key={String(flagged)} flagged={flagged} />
    </>
  );
}

function fetchEntries(flagged: boolean, before?: number) {
  return api.get<Listing>("/audit", {
    limit: PAGE,
    before,
    flagged: flagged ? 1 : undefined,
  });
}

function Entries({ flagged }: { flagged: boolean }) {
  const fetchFirst = useCallback(() => fetchEntries(flagged), [flagged]);
  const { data: first, error: loadError } = useLoaded(fetchFirst);
  const [older, setOlder] = useState<Listing[]>([]);
  const [error, setError] = useState("");

  if (!first) {
    return <Notice kind="error">{loadError ? describeError(loadError) : ""}</Notice>;
  }
  const entries = [first, ...older].flatMap((listing) => listing.entries);
  const next = (older.at(-1) ?? first).next_before;

  async function more(before: number) {
    setError("");
    try {
      const listing = await fetchEntries(flagged, before);
      setOlder((shown) => [...shown, listing]);
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  return (
    <>
      <Notice kind="error">{error}</Notice>
      {entries.length === 0 ? (
        <p className="text-muted">No entries.</p>
      ) : (
        <ol className="divide-y divide-line rounded-lg border border-line bg-panel">
          {entries.map((entry) => (
            <li key={entry.seq} data-testid="audit-row" className="p-4">
              <p className="flex flex-wrap items-baseline gap-x-3">
                <strong>{entry.event.replaceAll("_", " ")}</strong>
                {entry.flagged && (
                  <span className="rounded-md bg-notice px-2 font-mono text-xs uppercase text-on-notice">
                    Flagged
                  </span>
                )}
                <span className="font-mono text-xs text-muted">
                  #{entry.seq} · {shortDate(entry.at)} · {entry.actor}
                </span>
              </p>
              {Object.keys(entry.detail).length > 0 && (
                <p className="mt-1 break-all font-mono text-xs text-muted">
                  {Object.entries(entry.detail)
                    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                    .join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {next !== null && (
        <Button className="mt-6" onClick={() => more(next)}>
          Show older entries
        </Button>
      )}
    </>
  );
}
