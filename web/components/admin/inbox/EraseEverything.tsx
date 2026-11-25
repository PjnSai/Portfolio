"use client";

import Link from "next/link";
import { useState } from "react";
import { ADMIN, useAdmin } from "@/components/admin/AdminApp";
import { Button, Notice } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import {
  ERASE_WARNING,
  type EraseTarget,
  eraseApi,
  eraseRequested,
} from "@/lib/admin/erase";

const erase = eraseApi(api);

export function EraseView({
  alsoBlock,
  busy,
  error,
  requested,
  pendingHref,
  onAlsoBlock,
  onSubmit,
}: {
  alsoBlock: boolean;
  busy: boolean;
  error: string;
  /** What the API stored, once the owner has asked. */
  requested: EraseTarget | null;
  pendingHref: string;
  onAlsoBlock: (value: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section aria-labelledby="erase-title" className="mt-8 space-y-3">
      <h2 id="erase-title" className="text-xl font-bold">
        Delete everything about this email
      </h2>
      <p className="text-sm text-muted">
        For a deletion request. Removes every message and note from this email
        address and its saved contact, including messages marked to keep. Asks
        for your passkey, then waits 24 hours; you can cancel until it runs.
      </p>
      <p data-testid="erase-warning" className="text-sm font-semibold">
        {ERASE_WARNING}
      </p>
      <form onSubmit={onSubmit} aria-label="Delete everything" className="space-y-3">
        <label className="flex min-h-11 items-start gap-3">
          <input
            id="erase-also-block"
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={alsoBlock}
            onChange={(event) => onAlsoBlock(event.target.checked)}
          />
          <span>
            Also block this sender
            <span className="block text-sm text-muted">
              Keeps a block as a scrambled hash only. A kept address is removed.
            </span>
          </span>
        </label>
        <Button type="submit" variant="danger" disabled={busy}>
          Delete everything about this email
        </Button>
      </form>
      <Notice kind="error">{error}</Notice>
      {requested && (
        <p
          role="status"
          data-testid="erase-requested"
          className="rounded-md border-l-4 border-ok bg-panel px-4 py-3 text-sm text-ok"
        >
          Requested. {eraseRequested(requested)}{" "}
          <Link href={pendingHref} className="underline underline-offset-4">
            Review pending actions
          </Link>
        </p>
      )}
    </section>
  );
}

export function EraseEverything({
  from,
}: {
  from: { message: string } | { contact: string };
}) {
  const { vital, refreshPending } = useAdmin();
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState<EraseTarget | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setRequested(null);
    try {
      const action = await vital(() => erase.request(from, alsoBlock));
      setRequested(action.target);
      await refreshPending().catch(() => undefined);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <EraseView
      alsoBlock={alsoBlock}
      busy={busy}
      error={error}
      requested={requested}
      pendingHref={`${ADMIN}/pending`}
      onAlsoBlock={setAlsoBlock}
      onSubmit={submit}
    />
  );
}
