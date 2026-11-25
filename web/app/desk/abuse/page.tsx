"use client";

import { useCallback, useState } from "react";
import { AbuseDays, AbuseFilters, AbuseTotals, CountsOnlyNote } from "@/components/admin/security/AbuseViews";
import { Notice, PageTitle } from "@/components/admin/ui";
import { type AbuseKind, abuseApi, checkRange, defaultRange, type Range } from "@/lib/admin/abuse";
import { api, describeError } from "@/lib/admin/api";
import { useLoaded } from "@/lib/admin/use-loaded";

const abuse = abuseApi(api);

export default function AbusePage() {
  const [initial] = useState(() => defaultRange());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [kind, setKind] = useState<AbuseKind | "">("");
  const [applied, setApplied] = useState<Range>(initial);
  const [problem, setProblem] = useState("");

  const fetcher = useCallback(() => abuse.read(applied), [applied]);
  const { data, error } = useLoaded(fetcher);

  function show() {
    const wrong = checkRange(from, to);
    setProblem(wrong);
    if (!wrong) setApplied({ from, to, kind: kind || undefined });
  }

  return (
    <>
      <PageTitle>Abuse overview</PageTitle>
      <CountsOnlyNote />
      <AbuseFilters
        from={from}
        to={to}
        kind={kind}
        error={problem}
        busy={false}
        onChange={(change) => {
          if (change.from !== undefined) setFrom(change.from);
          if (change.to !== undefined) setTo(change.to);
          if (change.kind !== undefined) setKind(change.kind);
        }}
        onSubmit={show}
      />
      {error ? (
        <Notice kind="error">{describeError(error)}</Notice>
      ) : data === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <AbuseTotals summary={data} />
          <AbuseDays summary={data} />
        </>
      )}
    </>
  );
}
