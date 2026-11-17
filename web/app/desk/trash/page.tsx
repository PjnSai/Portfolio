"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { Button, Notice, PageTitle, Pager } from "@/components/admin/ui";
import { api, describeError, type Page } from "@/lib/admin/api";
import { typeLabel } from "@/lib/admin/content-types";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Entry = {
  entity: "section" | "item" | "media";
  id: string;
  label: string;
  type: string;
  trashed_at: string;
  purge_after: string;
};

const ENTITY_LABEL = { section: "Section", item: "Item", media: "Image" } as const;
const RESTORE_PATH = { section: "sections", item: "items", media: "media" } as const;

export default function Trash() {
  const { vital, refreshPending } = useAdmin();
  const [page, setPage] = useState(1);
  const fetchTrash = useCallback(() => api.get<Page<Entry>>("/trash", { page }), [page]);
  const { data: listing, error: loadError, reload } = useLoaded(fetchTrash);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function act(call: () => Promise<unknown>, message: string) {
    setError("");
    setDone("");
    try {
      await call();
      setDone(message);
      await reload();
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  function deleteForGood(entry: Entry) {
    return act(async () => {
      await vital(() =>
        api.post("/vital-actions/request", {
          kind: "permanent_delete",
          payload: { entity: entry.entity, id: entry.id },
        }),
      );
      await refreshPending();
    }, `“${entry.label}” will be deleted for good after 24 hours. You can cancel this on the Pending actions page until then.`);
  }

  return (
    <>
      <PageTitle>Trash</PageTitle>
      <p className="mb-6 text-muted">
        Anything here can be restored for 30 days, then it is deleted automatically.
        Deleting for good sooner needs your passkey and waits 24 hours.
      </p>
      <Notice kind="error">{error || (loadError ? describeError(loadError) : "")}</Notice>
      <Notice kind="done">{done}</Notice>
      {listing === null ? (
        <p className="text-muted">Loading…</p>
      ) : listing.results.length === 0 ? (
        <p className="text-muted">The trash is empty.</p>
      ) : (
        <ul className="space-y-3">
          {listing.results.map((entry) => (
            <li
              key={entry.id}
              data-testid="trash-row"
              className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-bold">{entry.label}</p>
                <p className="font-mono text-xs uppercase tracking-wide text-muted">
                  {ENTITY_LABEL[entry.entity]} ·{" "}
                  {entry.entity === "media" ? "" : `${typeLabel(entry.type)} · `}goes{" "}
                  {shortDate(entry.purge_after)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  aria-label={`Restore ${entry.label}`}
                  onClick={() =>
                    act(
                      () =>
                        api.post(
                          `/${RESTORE_PATH[entry.entity]}/${entry.id}/restore`,
                        ),
                      `“${entry.label}” is back.`,
                    )
                  }
                >
                  Restore
                </Button>
                {entry.entity !== "media" && (
                  <Button
                    variant="danger"
                    aria-label={`Delete ${entry.label} for good`}
                    onClick={() => deleteForGood(entry)}
                  >
                    Delete for good
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {listing && (
        <Pager page={listing.page} pages={listing.pages} onPage={setPage} />
      )}
    </>
  );
}
