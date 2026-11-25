"use client";

import { useCallback, useEffect, useState } from "react";
import { type PendingAction, useAdmin } from "@/components/admin/AdminApp";
import {
  DayCountsList,
  SwitchesCard,
  UploadCard,
  VersionRows,
  ViewLog,
} from "@/components/admin/cv/CvViews";
import { Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import {
  checkFile,
  type CvVersion,
  cvApi,
  pendingSwitches,
  type SwitchName,
  type Switches,
  switchesPayload,
  uploadMessage,
} from "@/lib/admin/cv";
import { useLoaded } from "@/lib/admin/use-loaded";

const cv = cvApi(api);

export default function CvPage() {
  const { vital, pending, refreshPending } = useAdmin();
  const versionsFetcher = useCallback(() => cv.versions(), []);
  const switchesFetcher = useCallback(() => cv.switches(), []);
  const daysFetcher = useCallback(() => cv.days(), []);
  const versions = useLoaded(versionsFetcher);
  const switches = useLoaded(switchesFetcher);
  const days = useLoaded(daysFetcher);
  const [page, setPage] = useState(1);
  const viewsFetcher = useCallback(() => cv.views(page), [page]);
  const views = useLoaded(viewsFetcher);

  const [now, setNow] = useState(() => new Date());
  const [draft, setDraft] = useState<Switches | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void refreshPending();
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [refreshPending]);

  async function act(call: () => Promise<unknown>, say: string) {
    setBusy(true);
    setDone("");
    setError("");
    try {
      await call();
      setDone(say);
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const waitingSwitches = pendingSwitches(pending).map(({ action }) => action);
  const current: Switches | null = switches.data
    ? {
        view: switches.data.view,
        request: switches.data.request,
        instant_download: switches.data.instant_download,
      }
    : null;

  async function askSwitches() {
    if (!current || !draft) return;
    const sent = await act(async () => {
      await vital(() => cv.requestSwitches(draft));
      await refreshPending();
    }, "Requested. It can run after 24 hours; until then you can cancel it here or on the Pending actions page.");
    if (sent) setDraft(null);
  }

  async function cancel(action: PendingAction, say: string) {
    await act(async () => {
      await api.post(`/vital-actions/${action.id}/cancel`);
      await refreshPending();
    }, say);
  }

  async function run(action: PendingAction) {
    await act(async () => {
      await vital(() => api.post(`/vital-actions/${action.id}/execute`, {}));
      await Promise.all([refreshPending(), switches.reload(), versions.reload(), days.reload()]);
    }, "Done.");
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setUploadError("");
    if (!file) return;
    const problem = checkFile(file);
    if (problem) {
      setUploadError(problem);
      return;
    }
    setBusy(true);
    setDone("");
    setError("");
    try {
      await vital(() => cv.upload(file));
      setDone("Uploaded. It is not live yet: choose Set live when you want it shown.");
      setFile(null);
      setFileKey((key) => key + 1);
      await versions.reload();
    } catch (failure) {
      setUploadError(uploadMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const waitingDeletions = pending.filter(
    (action) => action.kind === "permanent_delete" && action.target.entity === "cv_version",
  );
  const list = versions.data?.versions ?? [];

  return (
    <>
      <PageTitle>CV</PageTitle>
      <p className="mb-6 text-muted">
        Only the public CV goes here: professional details and nothing else. Visitors can view the live version in a
        pop-up and ask for a copy. A fuller CV is something you send by hand from your own email; the site sends no
        email.
      </p>
      <Notice kind="done">{done}</Notice>
      <Notice kind="error">
        {error || [versions, switches, days, views].map((each) => (each.error ? describeError(each.error) : "")).find(Boolean)}
      </Notice>

      {current === null ? (
        <p className="mb-10 text-muted">Loading…</p>
      ) : (
        <SwitchesCard
          current={current}
          draft={draft ?? current}
          pending={waitingSwitches}
          busy={busy}
          now={now}
          onChange={(name: SwitchName, value: boolean) =>
            setDraft(switchesPayload(draft ?? current, name, value))
          }
          onAsk={() => void askSwitches()}
          onCancel={(action) => void cancel(action, "Cancelled. Nothing was changed.")}
          onRun={(action) => void run(action)}
        />
      )}

      <section aria-labelledby="versions-title" className="mb-10">
        <h2 id="versions-title" className="mb-4 text-xl font-bold">
          Versions
        </h2>
        {versions.data === null ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <>
            <UploadCard
              key={fileKey}
              count={list.length}
              max={versions.data.max_versions}
              error={uploadError}
              busy={busy}
              hasFile={file !== null}
              onFile={(chosen) => {
                setFile(chosen);
                setUploadError("");
              }}
              onSubmit={(event) => void upload(event)}
            />
            <VersionRows
              versions={list}
              pending={waitingDeletions}
              busy={busy}
              now={now}
              onSetLive={(version: CvVersion) =>
                void act(async () => {
                  await vital(() => cv.setLive(version.id));
                  await versions.reload();
                  await switches.reload();
                }, "That version is now the live one.")
              }
              onDelete={(version: CvVersion) =>
                void act(async () => {
                  await vital(() => cv.requestDelete(version.id));
                  await refreshPending();
                }, "It will be deleted for good after 24 hours. You can cancel it here or on the Pending actions page.")
              }
              onCancelDelete={(action) => void cancel(action, "Cancelled. The version was kept.")}
            />
          </>
        )}
      </section>

      <section aria-labelledby="views-title" className="mb-10">
        <h2 id="views-title" className="mb-2 text-xl font-bold">
          Views
        </h2>
        <p className="mb-4 text-muted">
          Each view or download is logged with its time, the version, the country Cloudflare reports and the browser
          name. No address and no email is kept. Rows older than 90 days are counted into the totals by day and then
          removed.
        </p>
        <h3 className="mb-2 text-lg font-bold">Visits by day</h3>
        <div className="mb-6">
          {days.data === null ? <p className="text-muted">Loading…</p> : <DayCountsList counts={days.data} />}
        </div>
        <h3 className="mb-2 text-lg font-bold">Log, newest first</h3>
        {views.data === null ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <ViewLog rows={views.data.results} page={views.data.page} pages={views.data.pages} onPage={setPage} />
        )}
      </section>
    </>
  );
}
