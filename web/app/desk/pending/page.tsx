"use client";

import { useEffect, useState } from "react";
import { type PendingAction, useAdmin } from "@/components/admin/AdminApp";
import { PendingRow } from "@/components/admin/PendingRow";
import { Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { createPasskey } from "@/lib/admin/webauthn";

export default function Pending() {
  const { pending, refreshPending, vital } = useAdmin();
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    void refreshPending();
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [refreshPending]);

  async function act(call: () => Promise<unknown>, message: string) {
    setError("");
    setDone("");
    try {
      await call();
      setDone(message);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      await refreshPending().catch(() => undefined);
    }
  }

  function run(action: PendingAction) {
    return act(
      () =>
        vital(async () => {
          let credential;
          if (action.kind === "add_passkey") {
            const options = await api.post(`/vital-actions/${action.id}/passkey-options`);
            credential = await createPasskey(options);
          }
          await api.post(`/vital-actions/${action.id}/execute`, { credential });
        }),
      "Done.",
    );
  }

  return (
    <>
      <PageTitle>Pending actions</PageTitle>
      <p className="mb-6 text-muted">
        Vital actions wait 24 hours before they can run, and you were sent a notice
        for each. Cancel anything you did not ask for. Cancelling needs no passkey.
      </p>
      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>
      {pending.length === 0 ? (
        <p className="text-muted">Nothing is waiting.</p>
      ) : (
        <ul className="space-y-3">
          {pending.map((action) => (
            <PendingRow
              key={action.id}
              action={action}
              now={now}
              onCancel={() =>
                act(
                  () => api.post(`/vital-actions/${action.id}/cancel`),
                  "Cancelled. Nothing was changed.",
                )
              }
              onRun={() => run(action)}
            />
          ))}
        </ul>
      )}
    </>
  );
}
