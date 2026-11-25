import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AddBlockForm,
  BlockFields,
  BlockRows,
  BlockSize,
} from "@/components/admin/blocklist/BlocklistViews";
import { BlockPanelView } from "@/components/admin/inbox/BlockPanel";
import { ApiError, describeError } from "@/lib/admin/api";
import { type BlockEntry, checkBlockEmail, checkNote } from "@/lib/admin/blocklist";

const noop = () => {};
const NOW = new Date("2026-06-01T00:00:00Z");

function entry(over: Partial<BlockEntry> = {}): BlockEntry {
  return {
    id: "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e",
    email: null,
    note: "Kept sending offers",
    created_at: "2026-01-10T09:00:00Z",
    expires_at: "2027-01-10T09:00:00Z",
    hit_count: 4,
    last_hit_at: "2026-05-20T09:00:00Z",
    ...over,
  };
}

function rows(entries: BlockEntry[]) {
  return renderToStaticMarkup(
    <BlockRows entries={entries} busy={false} now={NOW} onRenew={noop} onRemove={noop} />,
  );
}

describe("the blocklist page", () => {
  it("shows the note, dates, hit count and last seen for each entry", () => {
    const html = rows([entry()]);
    expect(html).toContain("Kept sending offers");
    expect(html).toContain("10 Jan 2026");
    expect(html).toContain("Blocks until");
    expect(html).toContain("<dd");
    expect(html).toContain(">4<");
    expect(html).toContain("20 May 2026");
    expect(html).toContain("Renew");
    expect(html).toContain("Remove");
  });

  it("shows the address only when one is kept", () => {
    const hashOnly = rows([entry()]);
    expect(hashOnly).toContain("Address not kept (scrambled hash only)");
    expect(hashOnly).not.toContain("@");
    const kept = rows([entry({ email: "spam@example.org" })]);
    expect(kept).toContain("spam@example.org");
    expect(kept).not.toContain("Address not kept");
  });

  it("says never when nothing has been stopped, and marks an expired entry", () => {
    const html = rows([
      entry({ hit_count: 0, last_hit_at: null, expires_at: "2026-05-01T00:00:00Z" }),
    ]);
    expect(html).toContain("never");
    expect(html).toContain("Expired");
    expect(html).not.toContain("Blocks until");
  });

  it("says when nobody is blocked", () => {
    expect(rows([])).toContain("Nobody is blocked.");
  });

  it("shows how many entries still block out of the cap", () => {
    const html = renderToStaticMarkup(
      <BlockSize listing={{ entries: [], active: 12, max_entries: 500 }} />,
    );
    expect(html).toContain("12 of 500 places in use");
    expect(html).not.toContain("The list is full");
  });

  it("says in plain words when the list is full", () => {
    const html = renderToStaticMarkup(
      <BlockSize listing={{ entries: [], active: 500, max_entries: 500 }} />,
    );
    expect(html).toContain("The list is full");
    expect(describeError(new ApiError(409, { code: "blocklist_full" }))).toContain(
      "blocklist is full",
    );
  });
});

describe("the add form", () => {
  function form(over: Partial<Parameters<typeof AddBlockForm>[0]> = {}) {
    return renderToStaticMarkup(
      <AddBlockForm
        email=""
        note=""
        keepAddress={false}
        errors={{ email: "", note: "" }}
        busy={false}
        full={false}
        onEmail={noop}
        onNote={noop}
        onKeepAddress={noop}
        onSubmit={noop}
        {...over}
      />,
    );
  }

  it("has an address, a note limited to 200 characters, and the keep tick off", () => {
    const html = form();
    expect(html).toContain('type="email"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain("Keep the address so I can see it later");
    expect(html).toMatch(/type="checkbox"/);
    expect(html).not.toContain("checked");
  });

  it("shows the tick as on only when the owner turned it on", () => {
    expect(form({ keepAddress: true })).toContain("checked");
  });

  it("says what each problem is and marks the field", () => {
    const html = form({
      errors: { email: checkBlockEmail("nope"), note: checkNote("write to a@b.c") },
    });
    expect(html).toContain("Enter a full email address.");
    expect(html).toContain("Leave email addresses out of notes.");
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
  });

  it("stops adding when the list is full", () => {
    expect(form({ full: true })).toMatch(/<button[^>]*disabled[^>]*>Block this address/);
  });

  it("says a blocked sender is told the message was received", () => {
    expect(form()).toContain("told the message was received");
  });
});

describe("the Block sender button on a message", () => {
  function panel(over: Partial<Parameters<typeof BlockPanelView>[0]> = {}) {
    return renderToStaticMarkup(
      <BlockPanelView
        open={false}
        note=""
        keepAddress={false}
        noteError=""
        busy={false}
        error=""
        onOpen={noop}
        onClose={noop}
        onNote={noop}
        onKeepAddress={noop}
        onSubmit={noop}
        {...over}
      />,
    );
  }

  it("is a button until the owner opens it", () => {
    const html = panel();
    expect(html).toContain("Block sender");
    expect(html).not.toContain("<form");
  });

  it("opens the same note and tick, and says the message moves to spam", () => {
    const html = panel({ open: true });
    expect(html).toContain("this message");
    expect(html).toContain("moves to spam");
    expect(html).toContain('maxLength="200"');
    expect(html).toContain("Keep the address so I can see it later");
    expect(html).toContain("your passkey");
  });

  it("shows a refusal in words", () => {
    const html = panel({
      open: true,
      error: describeError(new ApiError(409, { code: "blocklist_full" })),
    });
    expect(html).toContain("blocklist is full");
  });

  it("uses the same fields as the add form", () => {
    const fields = renderToStaticMarkup(
      <BlockFields
        prefix="x"
        note=""
        keepAddress={false}
        noteError=""
        onNote={noop}
        onKeepAddress={noop}
      />,
    );
    expect(fields).toContain('id="x-note"');
    expect(fields).toContain('id="x-keep"');
  });
});
