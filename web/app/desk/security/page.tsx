"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { Button, Card, INPUT, Label, Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };

export default function Security() {
  const { refresh, refreshPending, vital } = useAdmin();
  const fetchPasskeys = useCallback(
    async () => (await api.get<{ passkeys: Passkey[] }>("/passkeys")).passkeys,
    [],
  );
  const { data, error: loadError } = useLoaded(fetchPasskeys);
  const passkeys = data ?? [];
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function act(call: () => Promise<unknown>, message: string) {
    setError("");
    setDone("");
    try {
      await call();
      setDone(message);
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

  async function requestVital(kind: string, payload: Record<string, string>) {
    const ok = await act(
      () => vital(() => api.post("/vital-actions/request", { kind, payload })),
      "Requested. It can run after 24 hours; until then you can cancel it on the Pending actions page.",
    );
    if (ok) await refreshPending();
    return ok;
  }

  return (
    <>
      <PageTitle>Security</PageTitle>
      <Notice kind="error">{error || (loadError ? describeError(loadError) : "")}</Notice>
      <Notice kind="done">{done}</Notice>

      <section className="mb-10 space-y-4">
        <Card>
          <h2 className="mb-2 text-lg font-bold">Sign out</h2>
          <p className="mb-4 text-sm text-muted">Ends the session on this device.</p>
          <Button
            variant="primary"
            onClick={() =>
              act(async () => {
                await api.post("/logout");
                await refresh();
              }, "")
            }
          >
            Sign out
          </Button>
        </Card>
        <Card>
          <h2 className="mb-2 text-lg font-bold">Sign out everywhere</h2>
          <p className="mb-4 text-sm text-muted">
            Ends every session on every device, including this one. Use it if a device
            was lost or you think someone else is signed in. Needs your passkey.
          </p>
          <Button
            variant="danger"
            onClick={() =>
              act(async () => {
                await vital(() => api.post("/sessions/revoke-all"));
                await refresh();
              }, "")
            }
          >
            Sign out everywhere
          </Button>
        </Card>
      </section>

      <section aria-labelledby="passkeys">
        <h2 id="passkeys" className="mb-4 text-2xl font-extrabold">
          Passkeys
        </h2>
        <ul className="mb-6 divide-y divide-line rounded-lg border border-line bg-panel">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <span>
                <strong>{passkey.name}</strong>
                <span className="block font-mono text-xs text-muted">
                  Added {shortDate(passkey.created_at)} · last used{" "}
                  {shortDate(passkey.last_used_at)}
                </span>
              </span>
              <Button
                variant="danger"
                disabled={passkeys.length < 2}
                onClick={() => requestVital("revoke_passkey", { id: passkey.id })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await requestVital("add_passkey", { name })) setName("");
          }}
        >
          <label className="block grow">
            <Label>Name for a new passkey</Label>
            <input
              className={INPUT}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <Button type="submit">Add a passkey</Button>
        </form>
        <p className="mt-2 text-sm text-muted">
          A new passkey can be added 24 hours after you ask, from the Pending actions
          page.
        </p>
      </section>
    </>
  );
}
