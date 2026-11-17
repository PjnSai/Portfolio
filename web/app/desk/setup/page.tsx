"use client";

import Link from "next/link";
import { useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { Button, INPUT, Label, Notice, PageTitle } from "@/components/admin/ui";
import { api, ApiError, describeError } from "@/lib/admin/api";
import { createPasskey } from "@/lib/admin/webauthn";

export default function Setup() {
  const { refresh } = useAdmin();
  const [token, setToken] = useState("");
  const [name, setName] = useState("First passkey");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [stored, setStored] = useState(false);

  async function enrol(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const options = await api.post("/bootstrap/options", { token });
      const credential = await createPasskey(options);
      const done = await api.post<{ recovery_key: string }>("/bootstrap/verify", {
        token,
        name,
        credential,
      });
      setToken("");
      setRecoveryKey(done.recovery_key);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 401
          ? "Set-up is closed, or the set-up token is wrong."
          : describeError(failure),
      );
    } finally {
      setBusy(false);
    }
  }

  if (recoveryKey) {
    return (
      <section aria-labelledby="recovery" className="max-w-xl">
        <PageTitle>
          <span id="recovery">Your recovery key</span>
        </PageTitle>
        <p className="mb-4">
          This is the only way back in if you lose every passkey. It is shown once
          and cannot be shown again. Write it down or print it, and keep it
          offline, away from this device.
        </p>
        <code
          data-testid="recovery-key"
          className="block break-all rounded-md border-2 border-ink bg-panel p-4 font-mono text-lg"
        >
          {recoveryKey}
        </code>
        <label className="mt-6 flex items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={stored}
            onChange={(e) => setStored(e.target.checked)}
          />
          I have stored the recovery key somewhere safe.
        </label>
        <Link
          href="/desk/sections"
          aria-disabled={!stored}
          onClick={(event) => {
            if (!stored) {
              event.preventDefault();
              return;
            }
            setRecoveryKey("");
            void refresh();
          }}
          className={`mt-6 inline-block rounded-md border border-ink bg-ink px-4 py-3 text-sm font-semibold text-paper ${stored ? "" : "pointer-events-none opacity-50"}`}
        >
          Continue to sign in
        </Link>
      </section>
    );
  }

  return (
    <section className="max-w-md">
      <PageTitle>Set up your first passkey</PageTitle>
      <p className="mb-6 text-muted">
        This works once, with the set-up token from the deployment. After that,
        new passkeys are added from the Security page.
      </p>
      <form onSubmit={enrol} className="space-y-4">
        <label className="block">
          <Label>Set-up token</Label>
          <input
            className={INPUT}
            type="password"
            autoComplete="off"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="block">
          <Label>Name for this passkey</Label>
          <input
            className={INPUT}
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          Create passkey
        </Button>
      </form>
      <Notice kind="error">{error}</Notice>
    </section>
  );
}
