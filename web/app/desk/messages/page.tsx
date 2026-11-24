"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ADMIN, useAdmin } from "@/components/admin/AdminApp";
import {
  FOCUS_IDS,
  InboxFilters,
  InboxTabs,
  MessageRows,
  MessageView,
} from "@/components/admin/inbox/InboxViews";
import { api, ApiError, describeError } from "@/lib/admin/api";
import {
  type Filters,
  filtersFrom,
  inboxApi,
  type MessageDetail,
  type MessageStatus,
  MOVE_LABEL,
  pageFrom,
  pendingDeletion,
  tabFrom,
  TABS,
  tabHref,
} from "@/lib/admin/inbox";
import { useLoaded } from "@/lib/admin/use-loaded";

// One static page; the message, the folder, the filters and the page number
// come from the query string, because messages exist only after the site is
// built.
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
  const filters = filtersFrom((name) => params.get(name));
  const notice = params.get("notice");
  if (id !== null) {
    return ID.test(id) ? (
      <Detail key={id} id={id} tab={tab} page={page} filters={filters} />
    ) : (
      <ListScreen tab={tab} page={page} filters={filters} notice="" missing />
    );
  }
  return (
    <ListScreen
      tab={tab}
      page={page}
      filters={filters}
      notice={notice === "deleted" ? "Message deleted." : ""}
    />
  );
}

function ListScreen({
  tab,
  page,
  filters,
  notice,
  missing = false,
}: {
  tab: ReturnType<typeof tabFrom>;
  page: number;
  filters: Filters;
  notice: string;
  missing?: boolean;
}) {
  const router = useRouter();
  const filterKey = JSON.stringify(filters);
  const fetcher = useCallback(
    () => inbox.list(tab, page, JSON.parse(filterKey) as Filters),
    [tab, page, filterKey],
  );
  const { data: listing, error: loadError } = useLoaded(fetcher);
  const heading = useRef<HTMLHeadingElement>(null);
  const [done, setDone] = useState(notice);
  const label = TABS.find((entry) => entry.tab === tab)?.label ?? "Inbox";

  // After a deletion is carried out elsewhere and the owner comes back here
  // with a notice, say so and take it out of the address.
  useEffect(() => {
    if (!notice) return;
    heading.current?.focus();
    router.replace(tabHref(BASE, tab, page, filters));
  }, [notice, router, tab, page, filters]);

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
      <InboxTabs
        base={BASE}
        tab={tab}
        counts={listing?.counts ?? null}
        filters={filters}
      />
      <InboxFilters
        key={filterKey}
        filters={filters}
        onApply={(next) => router.push(tabHref(BASE, tab, 1, next))}
      />
      <h2
        id={FOCUS_IDS.list}
        ref={heading}
        tabIndex={-1}
        className="mb-4 text-xl font-bold"
      >
        {label}
        {listing
          ? `: ${listing.count} ${listing.count === 1 ? "message" : "messages"}`
          : ""}
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
          filters={filters}
          onPage={(next) => router.push(tabHref(BASE, tab, next, filters))}
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
  filters,
}: {
  id: string;
  tab: ReturnType<typeof tabFrom>;
  page: number;
  filters: Filters;
}) {
  const { pending, refreshPending, vital } = useAdmin();
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
    // Keep waiting if the element is not on the page yet (it appears once the
    // list of waiting deletions has been refreshed).
    const element = document.getElementById(FOCUS_IDS[target]);
    if (!element) return;
    nextFocus.current = null;
    element.focus();
  });

  // The list of waiting deletions comes from the admin shell; make sure it is
  // current when a message is opened.
  useEffect(() => {
    void refreshPending().catch(() => undefined);
  }, [refreshPending]);

  function setFocus(target: Focus) {
    nextFocus.current = target;
    rerender((count) => count + 1);
  }

  const back = tabHref(BASE, tab, page, filters);
  const backLabel = TABS.find((entry) => entry.tab === tab)?.label ?? "Inbox";
  const waiting = pendingDeletion(pending, id);

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
        pendingHref={`${ADMIN}/pending`}
        busy={busy}
        confirming={confirming}
        deletion={
          waiting
            ? {
                state: waiting.state,
                executeAfter: waiting.execute_after,
                expiresAt: waiting.expires_at,
              }
            : null
        }
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
        onRequestDelete={() =>
          run(
            async () => {
              await vital(() => inbox.requestDelete(id));
              await refreshPending();
            },
            () => {
              setConfirming(false);
              setDone(
                "Deletion requested. It waits 24 hours and you can cancel it here until it runs.",
              );
            },
            "heading",
          )
        }
        onCancelDeletion={() =>
          run(
            async () => {
              if (waiting)
                await api.post(`/vital-actions/${waiting.id}/cancel`);
              await refreshPending();
            },
            () => setDone("Deletion cancelled. The message is unchanged."),
            "delete",
          )
        }
      />
    </>
  );
}
