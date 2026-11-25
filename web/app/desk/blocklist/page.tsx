"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import {
  AddBlockForm,
  BlockRows,
  BlockSize,
} from "@/components/admin/blocklist/BlocklistViews";
import { Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import {
  blocklistApi,
  checkBlockEmail,
  checkNote,
  isFull,
} from "@/lib/admin/blocklist";
import { useLoaded } from "@/lib/admin/use-loaded";

const blocklist = blocklistApi(api);

export default function BlocklistPage() {
  const fetcher = useCallback(() => blocklist.list(), []);
  const { data: listing, error: loadError, reload } = useLoaded(fetcher);
  const { vital } = useAdmin();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [keepAddress, setKeepAddress] = useState(false);
  const [errors, setErrors] = useState({ email: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  async function act(call: () => Promise<unknown>, say: string) {
    setBusy(true);
    setDone("");
    setError("");
    try {
      await call();
      setDone(say);
      await reload();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const next = { email: checkBlockEmail(email), note: checkNote(note) };
    setErrors(next);
    if (next.email || next.note) return;
    const added = await act(
      () => vital(() => blocklist.add(email, { note, keepAddress })),
      "Address blocked.",
    );
    if (added) {
      setEmail("");
      setNote("");
      setKeepAddress(false);
    }
  }

  return (
    <>
      <PageTitle>Blocklist</PageTitle>
      <p className="mb-6 text-muted">
        Senders whose messages are not stored. By default an entry holds only a
        scrambled hash of the address, so this list cannot be read back as
        addresses; you can choose to keep an address when you add one. Entries
        end by themselves after the number of months set in Settings, unless you
        renew them. Renewing, removing and adding ask for your passkey.
      </p>
      <Notice kind="done">{done}</Notice>
      <Notice kind="error">
        {error || (loadError ? describeError(loadError) : "")}
      </Notice>
      {listing === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <>
          <BlockSize listing={listing} />
          <section aria-labelledby="add-block-title" className="mb-10">
            <h2 id="add-block-title" className="mb-4 text-xl font-bold">
              Block an address
            </h2>
            <AddBlockForm
              email={email}
              note={note}
              keepAddress={keepAddress}
              errors={errors}
              busy={busy}
              full={isFull(listing)}
              onEmail={setEmail}
              onNote={setNote}
              onKeepAddress={setKeepAddress}
              onSubmit={add}
            />
          </section>
          <section aria-labelledby="entries-title">
            <h2 id="entries-title" className="mb-4 text-xl font-bold">
              Entries
            </h2>
            <BlockRows
              entries={listing.entries}
              busy={busy}
              onRenew={(id) =>
                act(() => vital(() => blocklist.renew(id)), "Block renewed.")
              }
              onRemove={(id) =>
                act(() => vital(() => blocklist.remove(id)), "Block removed.")
              }
            />
          </section>
        </>
      )}
    </>
  );
}
