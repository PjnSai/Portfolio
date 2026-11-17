"use client";

import { useEffect, useState } from "react";
import { type PendingAction, useAdmin } from "@/components/admin/AdminApp";
import { Button, Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { shortDate, timeLeft } from "@/lib/admin/time";
import { createPasskey } from "@/lib/admin/webauthn";

function describe(action: PendingAction): string {
  switch (action.kind) {
    case "permanent_delete":
      return `Delete a ${action.target.entity ?? "record"} for good`;
    case "add_passkey":
      return `Add a passkey called “${action.target.name}”`;
    case "revoke_passkey":
      return "Remove a passkey";
    default:
      return action.kind;
  }
}

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
            <li
              key={action.id}
              data-testid="pending-row"
              className="rounded-lg border-2 border-ink bg-panel p-4"
            >
              <p className="font-bold">{describe(action)}</p>
              <p className="mb-4 text-sm text-muted">
                Requested {shortDate(action.requested_at)}.{" "}
                {action.state === "waiting" ? (
                  <span data-testid="time-left">
                    Can run in {timeLeft(action.execute_after, now).replace(" left", "")}.
                  </span>
                ) : (
                  <span data-testid="time-left">
                    Ready. Expires unused in{" "}
                    {timeLeft(action.expires_at, now).replace(" left", "")}.
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  onClick={() =>
                    act(
                      () => api.post(`/vital-actions/${action.id}/cancel`),
                      "Cancelled. Nothing was changed.",
                    )
                  }
                >
                  Cancel this action
                </Button>
                {action.state === "ready" && (
                  <Button variant="primary" onClick={() => run(action)}>
                    Run now
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
