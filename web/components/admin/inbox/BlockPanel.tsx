"use client";

import { useState } from "react";
import { BlockFields } from "@/components/admin/blocklist/BlocklistViews";
import { useAdmin } from "@/components/admin/AdminApp";
import { Button, Notice } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { blocklistApi, checkNote } from "@/lib/admin/blocklist";
import type { MessageDetail } from "@/lib/admin/inbox";

const blocklist = blocklistApi(api);

export function BlockPanelView({
  open,
  note,
  keepAddress,
  noteError,
  busy,
  error,
  onOpen,
  onClose,
  onNote,
  onKeepAddress,
  onSubmit,
}: {
  open: boolean;
  note: string;
  keepAddress: boolean;
  noteError: string;
  busy: boolean;
  error: string;
  onOpen: () => void;
  onClose: () => void;
  onNote: (text: string) => void;
  onKeepAddress: (keep: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section aria-labelledby="block-panel-title" className="mt-8 space-y-3">
      <h2 id="block-panel-title" className="text-xl font-bold">
        Block this sender
      </h2>
      {open ? (
        <form
          onSubmit={onSubmit}
          noValidate
          aria-label="Block sender"
          className="space-y-4 rounded-lg border border-line bg-panel p-4"
        >
          <p className="text-sm text-muted">
            Future messages from this address are not stored, and this message
            moves to spam. The sender is told the message was received. Asks for
            your passkey.
          </p>
          <BlockFields
            prefix="message"
            note={note}
            keepAddress={keepAddress}
            noteError={noteError}
            onNote={onNote}
            onKeepAddress={onKeepAddress}
          />
          <Notice kind="error">{error}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={busy}>
              Block this sender
            </Button>
            <Button disabled={busy} onClick={onClose}>
              Not now
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Button id="block-sender" variant="danger" onClick={onOpen}>
            Block sender
          </Button>
          <Notice kind="error">{error}</Notice>
        </>
      )}
    </section>
  );
}

export function BlockPanel({
  message,
  onBlocked,
}: {
  message: MessageDetail;
  onBlocked: (updated: MessageDetail) => void;
}) {
  const { vital } = useAdmin();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [keepAddress, setKeepAddress] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const problem = checkNote(note);
    setNoteError(problem);
    if (problem) return;
    setBusy(true);
    setError("");
    try {
      const result = await vital(() =>
        blocklist.blockMessage(message.id, { note, keepAddress }),
      );
      setOpen(false);
      setNote("");
      setKeepAddress(false);
      onBlocked(result.message);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BlockPanelView
      open={open}
      note={note}
      keepAddress={keepAddress}
      noteError={noteError}
      busy={busy}
      error={error}
      onOpen={() => setOpen(true)}
      onClose={() => {
        setOpen(false);
        setError("");
      }}
      onNote={(text) => {
        setNote(text);
        setNoteError("");
      }}
      onKeepAddress={setKeepAddress}
      onSubmit={submit}
    />
  );
}
