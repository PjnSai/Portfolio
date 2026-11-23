"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ADMIN } from "@/components/admin/AdminApp";
import {
  FOCUS_IDS,
  InboxTabs,
  MessageRows,
  MessageView,
} from "@/components/admin/inbox/InboxViews";
import { api, ApiError, describeError } from "@/lib/admin/api";
import {
  inboxApi,
  type MessageDetail,
  type MessageStatus,
  MOVE_LABEL,
  pageFrom,
  tabFrom,
  tabHref,
  TABS,
} from "@/lib/admin/inbox";
import { useLoaded } from "@/lib/admin/use-loaded";

// One static page; the message and the tab come from the query string, because
// messages are made after the site is built.
const ID = /^[0-9a-f-]{36}$/;
const BASE = `${ADMIN}/messages`;
const inbox = inboxApi(api);

export default function MessagesPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <FromQuery />
    </Suspense>
  );
}

/** Messages the owner is told about, always in the page so a reader hears them. */
function LiveRegions({ done, error }: { done: string; error: string }) {
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={
          done
            ? "my-4 rounded-md border-l-4 border-ok bg-panel px-4 py-3 text-sm text-ok"
            : ""
        }
      >
        {done}
      </p>
      <p
        role="alert"
        className={
          error
            ? "my-4 rounded-md border-l-4 border-danger bg-panel px-4 py-3 text-sm text-danger"
            : ""
        }
      >
        {error}
      </p>
    </>
  );
}

function FromQuery() {
  const params = useSearchParams();
  const id = params.get("id");
  const tab = tabFrom(params.get("status"));
  const page = pageFrom(params.get("page"));
  const notice = params.get("notice");
  if (id !== null) {
    return ID.test(id) ? (
      <Detail key={id} id={id} tab={tab} page={page} />
    ) : (
      <ListScreen tab={tab} page={page} notice="" missing />
    );
  }
  return (
    <ListScreen
      tab={tab}
      page={page}
      notice={notice === "deleted" ? "Message deleted." : ""}
    />
  );
}

function ListScreen({
  tab,
  page,
  notice,
  missing = false,
}: {
  tab: ReturnType<typeof tabFrom>;
  page: number;
  notice: string;
  missing?: boolean;
}) {
  const router = useRouter();
  const fetcher = useCallback(() => inbox.list(tab, page), [tab, page]);
  const { data: listing, error: loadError } = useLoaded(fetcher);
  const heading = useRef<HTMLHeadingElement>(null);
  const [done, setDone] = useState(notice);
  const label = TABS.find((entry) => entry.tab === tab)?.label ?? "Inbox";

  // After deleting a message, say so and take the notice out of the address.
  useEffect(() => {
    if (!notice) return;
    heading.current?.focus();
    router.replace(tabHref(BASE, tab, page));
  }, [notice, router, tab, page]);

  // After moving to another page of the list, announce it and put focus on the
  // list heading so the next Tab goes to the first message.
  const shownPage = listing?.page;
  const first = useRef(true);
  useEffect(() => {
    if (shownPage === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
    setDone(`Page ${shownPage}.`);
  }, [shownPage]);

  return (
    <>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">Messages</h1>
      <p className="mb-6 text-muted">
        Messages from the contact form. Email addresses are what the sender
        typed and are not verified. Replies open in your own mail program.
      </p>
      <LiveRegions
        done={done}
        error={
          missing
            ? "That message does not exist."
            : loadError
              ? describeError(loadError)
              : ""
        }
      />
      <InboxTabs base={BASE} tab={tab} counts={listing?.counts ?? null} />
      <h2 ref={heading} tabIndex={-1} className="mb-4 text-xl font-bold">
        {label}
        {listing && listing.pages > 1
          ? `, page ${listing.page} of ${listing.pages}`
          : ""}
      </h2>
      {listing === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <MessageRows
          base={BASE}
          listing={listing}
          tab={tab}
          onPage={(next) => router.push(tabHref(BASE, tab, next))}
        />
      )}
    </>
  );
}

type Focus = "heading" | "note" | "delete" | "cancel" | null;

function Detail({
  id,
  tab,
  page,
}: {
  id: string;
  tab: ReturnType<typeof tabFrom>;
  page: number;
}) {
  const router = useRouter();
  const fetcher = useCallback(() => inbox.open(id), [id]);
  const { data: loaded, error: loadError } = useLoaded(fetcher);
  // The message as loaded, until the owner changes something.
  const [changed, setChanged] = useState<MessageDetail | null>(null);
  const [gone, setGone] = useState(false);
  const message = gone ? null : (changed ?? loaded);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState("");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  // Where focus goes once the page has re-rendered after an action.
  const nextFocus = useRef<Focus>("heading");
  const [, rerender] = useState(0);

  useEffect(() => {
    const target = nextFocus.current;
    if (!target || !message) return;
    nextFocus.current = null;
    document.getElementById(FOCUS_IDS[target])?.focus();
  });

  function setFocus(target: Focus) {
    nextFocus.current = target;
    rerender((count) => count + 1);
  }

  const back = tabHref(BASE, tab, page);
  const backLabel = TABS.find((entry) => entry.tab === tab)?.label ?? "Inbox";

  async function run<T>(
    call: () => Promise<T>,
    then: (result: T) => void,
    next: Focus,
  ) {
    setBusy(true);
    setError("");
    setDone("");
    try {
      then(await call());
      setFocus(next);
    } catch (failure) {
      setError(describeError(failure));
      if (failure instanceof ApiError && failure.status === 404) setGone(true);
    } finally {
      setBusy(false);
    }
  }

  function applyDetail(updated: MessageDetail, say: string) {
    setChanged(updated);
    setDone(say);
  }

  if (!message) {
    return (
      <>
        <h1 className="mb-6 text-3xl font-extrabold tracking-tight">
          Messages
        </h1>
        <LiveRegions
          done=""
          error={error || (loadError ? describeError(loadError) : "")}
        />
        {loadError || error ? (
          <p>
            <a href={back} className="underline underline-offset-4">
              Back to {backLabel}
            </a>
          </p>
        ) : (
          <p className="text-muted">Loading…</p>
        )}
      </>
    );
  }

  const current = message;

  return (
    <>
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">Messages</h1>
      <LiveRegions done={done} error={error} />
      <MessageView
        message={current}
        backHref={back}
        backLabel={backLabel}
        busy={busy}
        confirming={confirming}
        noteText={noteText}
        noteError={noteError}
        onNoteText={(text) => {
          setNoteText(text);
          setNoteError("");
        }}
        onMove={(status: MessageStatus) =>
          run(
            () => inbox.setStatus(id, status),
            (updated) => applyDetail(updated, `${MOVE_LABEL[status]}: done.`),
            "heading",
          )
        }
        onAddNote={() => {
          if (!noteText.trim()) {
            setNoteError("Write a note first.");
            setFocus("note");
            return;
          }
          return run(
            () => inbox.addNote(id, noteText.trim()),
            (note) => {
              setChanged({ ...current, notes: [...current.notes, note] });
              setNoteText("");
              setDone("Note added.");
            },
            "note",
          );
        }}
        onLogResponse={() =>
          run(
            () => inbox.logResponse(id, noteText.trim()),
            (note) => {
              setChanged({
                ...current,
                status: "replied",
                notes: [...current.notes, note],
              });
              setNoteText("");
              setDone("Response logged. The message is marked as replied.");
            },
            "heading",
          )
        }
        onToggleKept={() =>
          run(
            () => inbox.setKept(id, !current.kept),
            (updated) =>
              applyDetail(
                updated,
                updated.kept
                  ? "Kept: it will not be removed automatically."
                  : "No longer kept.",
              ),
            "heading",
          )
        }
        onNotSpam={() =>
          run(
            () => inbox.notSpam(id),
            (updated) =>
              applyDetail(updated, "Moved to the inbox as a new message."),
            "heading",
          )
        }
        onAskDelete={() => {
          setConfirming(true);
          setFocus("cancel");
        }}
        onCancelDelete={() => {
          setConfirming(false);
          setFocus("delete");
        }}
        onDelete={() =>
          run(
            () => inbox.remove(id),
            () => {
              const list = tabHref(BASE, tab, page);
              router.push(
                `${list}${list.includes("?") ? "&" : "?"}notice=deleted`,
              );
            },
            null,
          )
        }
      />
    </>
  );
}
