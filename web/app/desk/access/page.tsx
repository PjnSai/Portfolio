"use client";

import { useCallback } from "react";
import { AccessNotes, PrincipalCard, SuperuserWarning } from "@/components/admin/security/AccessViews";
import { Notice, PageTitle } from "@/components/admin/ui";
import { accessApi, hasSuperuserWarning } from "@/lib/admin/access";
import { api, describeError } from "@/lib/admin/api";
import { useLoaded } from "@/lib/admin/use-loaded";

const access = accessApi(api);

export default function AccessPage() {
  const fetcher = useCallback(() => access.read(), []);
  const { data, error } = useLoaded(fetcher);

  return (
    <>
      <PageTitle>Access review</PageTitle>
      <p className="mb-6 text-muted">
        Everything that can touch this site, what each can and cannot do, and when it was last used.
      </p>
      <AccessNotes />
      {error ? (
        <Notice kind="error">{describeError(error)}</Notice>
      ) : data === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          {hasSuperuserWarning(data) && <SuperuserWarning />}
          <div className="space-y-6">
            {data.map((principal) => (
              <PrincipalCard key={principal.id} principal={principal} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
