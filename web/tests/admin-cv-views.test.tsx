import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeAction, PendingRow } from "@/components/admin/PendingRow";
import {
  DayCountsList,
  SwitchesCard,
  UploadCard,
  VersionRows,
  ViewLog,
} from "@/components/admin/cv/CvViews";
import { type CvVersion, type Switches, type ViewRow } from "@/lib/admin/cv";

const noop = () => {};
const NOW = new Date("2026-11-25T12:00:00Z");
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const ON: Switches = { view: true, request: true, instant_download: true };

const waiting = (target: Record<string, string | number | boolean>, kind = "cv_switches", id = "act-1") => ({
  id,
  kind,
  target,
  state: "waiting" as const,
  requested_at: "2026-11-25T10:00:00Z",
  execute_after: "2026-11-26T10:00:00Z",
  expires_at: "2026-12-02T10:00:00Z",
});

const version = (over: Partial<CvVersion> = {}): CvVersion => ({
  id: ID,
  size: 120_000,
  sha256: "a".repeat(64),
  created_at: "2026-11-20T10:00:00Z",
  is_live: false,
  file: "",
  ...over,
});

function switches(props: Partial<Parameters<typeof SwitchesCard>[0]> = {}) {
  return renderToStaticMarkup(
    <SwitchesCard
      current={ON}
      draft={ON}
      pending={[]}
      busy={false}
      now={NOW}
      onChange={noop}
      onAsk={noop}
      onCancel={noop}
      onRun={noop}
      {...props}
    />,
  );
}

describe("the switches card", () => {
  it("has the three switches, each labelled and explained", () => {
    const html = switches();
    for (const label of ["Viewing", "Requests", "Instant download"]) expect(html).toContain(label);
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).toContain("There is no download button in it");
    expect(html).toContain("works for a minute");
  });

  it("says a change needs the passkey and waits 24 hours", () => {
    expect(switches()).toMatch(/passkey/);
    expect(switches()).toMatch(/24 hours/);
  });

  it("has the ask button off until something differs from what is in force", () => {
    expect(switches()).toMatch(/<button[^>]*disabled=""[^>]*>Ask to change the switches/);
    const html = switches({ draft: { ...ON, instant_download: false } });
    expect(html).not.toMatch(/disabled=""[^>]*>Ask to change/);
    expect(html).toContain("Ask to change the switches");
  });

  it("shows the current state of each switch", () => {
    const html = switches({ current: { ...ON, request: false }, draft: { ...ON, request: false } });
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });

  it("shows a waiting change with its wait and a cancel, and stops another being asked for", () => {
    const html = switches({ pending: [waiting({ view: false, request: true, instant_download: true })] });
    expect(html).toContain("View: off. Request: on. Instant download: on.");
    expect(html).toContain("Can run in 22 h 0 min");
    expect(html).toContain("Cancel this action");
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
    expect(html).toMatch(/waiting/i);
  });

  it("lets a change that is ready be run", () => {
    const ready = { ...waiting({ view: false, request: true, instant_download: true }), state: "ready" as const };
    expect(switches({ pending: [ready] })).toContain("Run now");
  });
});

describe("a pending switch change or CV deletion elsewhere", () => {
  it("is described in words, not by its kind", () => {
    expect(describeAction(waiting({}) as never)).toBe("Change the CV switches");
    expect(describeAction(waiting({ entity: "cv_version", id: ID }, "permanent_delete") as never)).toBe(
      "Delete a CV version for good",
    );
    expect(describeAction(waiting({ entity: "message", id: ID }, "permanent_delete") as never)).toBe(
      "Delete a message for good",
    );
  });

  it("shows what the switches will be", () => {
    const html = renderToStaticMarkup(
      <PendingRow
        action={waiting({ view: false, request: true, instant_download: false }) as never}
        now={NOW}
        onCancel={noop}
        onRun={noop}
      />,
    );
    expect(html).toContain("View: off. Request: on. Instant download: off.");
    expect(html).toContain('data-testid="cv-summary"');
  });
});

describe("the upload card", () => {
  const card = (props: Partial<Parameters<typeof UploadCard>[0]> = {}) =>
    renderToStaticMarkup(
      <UploadCard count={2} max={10} error="" busy={false} hasFile onFile={noop} onSubmit={noop} {...props} />,
    );

  it("has a labelled PDF-only picker with size and type hints", () => {
    const html = card();
    expect(html).toMatch(/<label[^>]*>[^<]*<span[^>]*>Choose a PDF/);
    expect(html).toContain('accept=".pdf,application/pdf"');
    expect(html).toContain("5 MB");
    expect(html).toContain("no password");
    expect(html).toContain("not made live until you choose");
    expect(html).toContain("2 of 10 versions");
  });

  it("shows the API's message as an alert tied to the picker", () => {
    const html = card({ error: "That PDF is protected with a password. Upload one without a password." });
    expect(html).toContain("That PDF is protected with a password.");
    expect(html).toMatch(/aria-invalid="true"/);
  });

  it("is off, with the reason, when the versions are full", () => {
    const html = card({ count: 10 });
    expect(html).toContain("Delete one before uploading another.");
    expect(html).toMatch(/type="file"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Upload/);
  });

  it("keeps Upload off until a file is chosen", () => {
    expect(card({ hasFile: false })).toMatch(/<button[^>]*disabled=""[^>]*>Upload/);
    expect(card()).not.toMatch(/disabled=""[^>]*>Upload/);
  });
});

describe("the versions", () => {
  const rows = (list: CvVersion[], pending: ReturnType<typeof waiting>[] = [], busy = false) =>
    renderToStaticMarkup(
      <VersionRows
        versions={list}
        pending={pending}
        busy={busy}
        now={NOW}
        onSetLive={noop}
        onDelete={noop}
        onCancelDelete={noop}
      />,
    );

  it("says there are none", () => {
    expect(rows([])).toContain("No versions yet.");
  });

  it("shows a live badge, the size and the date", () => {
    const html = rows([version({ is_live: true })]);
    expect(html).toContain("Live");
    expect(html).toContain("117 KB");
    expect(html).toContain("20 Nov 2026");
  });

  it("offers Set live only for a version that is not live", () => {
    const html = rows([version({ is_live: true }), version({ id: OTHER })]);
    expect(html.match(/>Set live</g)).toHaveLength(1);
  });

  it("does not offer deleting the live version, and says why", () => {
    const html = rows([version({ is_live: true })]);
    expect(html).not.toContain("Delete for good");
    expect(html).toContain("The live version cannot be deleted.");
  });

  it("offers deleting an older version, with the wait said", () => {
    const html = rows([version()]);
    expect(html).toContain("Delete for good");
    expect(html).toContain("24 hours");
  });

  it("gives each version a download to attach to an email", () => {
    const html = rows([version()]);
    expect(html).toMatch(/<a[^>]*href="[^"]*\/api\/v1\/admin\/cv\/versions\/11111111-1111-4111-8111-111111111111\/file"[^>]*>Download to attach/);
    expect(html).toContain("download");
  });

  it("shows a deletion waiting out its 24 hours, with a cancel", () => {
    const html = rows([version()], [waiting({ entity: "cv_version", id: ID }, "permanent_delete")]);
    expect(html).toContain("Will be deleted");
    expect(html).toContain("Cancel deletion");
    expect(html).not.toContain("Delete for good");
  });

  it("turns the buttons off while something is being done", () => {
    expect(rows([version()], [], true)).toMatch(/disabled=""[^>]*>Set live/);
  });
});

describe("the views", () => {
  const row = (over: Partial<ViewRow> = {}): ViewRow => ({
    id: "r1",
    at: "2026-11-24T09:30:00Z",
    version: ID,
    kind: "view",
    country: "GB",
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0",
    ...over,
  });

  it("lists the kind, country, browser and time, and nothing that identifies a visitor", () => {
    const html = renderToStaticMarkup(
      <ViewLog rows={[row(), row({ id: "r2", kind: "download", country: "" })]} page={1} pages={1} onPage={noop} />,
    );
    expect(html).toContain("Viewed");
    expect(html).toContain("Downloaded");
    expect(html).toContain("GB");
    expect(html).toContain("Unknown");
    expect(html).toContain("Firefox/140.0");
    expect(html).toContain("24 Nov 2026");
    expect(html).not.toMatch(/IP address|email/i);
  });

  it("says when nothing has been seen", () => {
    expect(renderToStaticMarkup(<ViewLog rows={[]} page={1} pages={1} onPage={noop} />)).toContain("Nobody has");
  });

  it("pages the log", () => {
    const html = renderToStaticMarkup(<ViewLog rows={[row()]} page={2} pages={3} onPage={noop} />);
    expect(html).toContain("Page 2 of 3");
  });

  it("lists the counts per day, newest first as the API sends them, with the total", () => {
    const html = renderToStaticMarkup(
      <DayCountsList
        counts={{
          days: [
            { day: "2026-11-24", count: 3 },
            { day: "2026-11-23", count: 1 },
          ],
          total: 4,
        }}
      />,
    );
    expect(html.indexOf("24 Nov 2026")).toBeLessThan(html.indexOf("23 Nov 2026"));
    expect(html).toContain("3 visits");
    expect(html).toContain("1 visit<");
    expect(html).toContain("4 in all");
  });

  it("says when there are no counts", () => {
    expect(renderToStaticMarkup(<DayCountsList counts={{ days: [], total: 0 }} />)).toContain("No visits");
  });
});
