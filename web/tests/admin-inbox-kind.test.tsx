import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InboxFilters,
  InboxTabs,
  MessageRows,
  MessageView,
} from "@/components/admin/inbox/InboxViews";
import { createClient } from "@/lib/admin/api";
import {
  detailHref,
  type Filters,
  filtersFrom,
  hasFilters,
  inboxApi,
  KIND_LABEL,
  type MessageDetail,
  type MessageList,
  mailtoHref,
  NO_FILTERS,
  tabHref,
} from "@/lib/admin/inbox";

const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";
const COUNTS = { new: 2, read: 3, replied: 1, archived: 4, spam: 5 };
const noop = () => {};

function row(kind?: "message" | "cv_request") {
  return {
    id: ID,
    name: "Sam Recruiter",
    email: "sam@example.com",
    status: "new" as const,
    reason: "" as const,
    spam_score: 0,
    created_at: "2026-03-01T10:00:00Z",
    kept: false,
    contact_id: null,
    snippet: "Request for a copy of the CV.",
    ...(kind ? { kind } : {}),
  };
}

const list = (kind?: "message" | "cv_request"): MessageList => ({
  results: [row(kind)],
  page: 1,
  pages: 1,
  count: 1,
  counts: COUNTS,
});

const rows = (listing: MessageList, filters: Filters = NO_FILTERS) =>
  renderToStaticMarkup(
    <MessageRows base="/desk/messages" listing={listing} tab="inbox" filters={filters} onPage={noop} />,
  );

function detail(kind?: "message" | "cv_request"): MessageDetail {
  return {
    id: ID,
    name: "Sam Recruiter",
    email: "sam@example.com",
    body: "Request for a copy of the CV.\n\nNote from the sender:\nPlease send the accessible one.",
    reason: "",
    spam_score: 0,
    status: "new",
    created_at: "2026-03-01T10:00:00Z",
    read_at: null,
    kept: false,
    contact_id: null,
    expires_at: "2026-05-30T10:00:00Z",
    notes: [],
    ...(kind ? { kind } : {}),
  };
}

function view(kind?: "message" | "cv_request") {
  return renderToStaticMarkup(
    <MessageView
      message={detail(kind)}
      backHref="/desk/messages"
      backLabel="Inbox"
      pendingHref="/desk/pending"
      busy={false}
      confirming={false}
      deletion={null}
      noteText=""
      noteError=""
      onNoteText={noop}
      onMove={noop}
      onAddNote={noop}
      onLogResponse={noop}
      onToggleKept={noop}
      onNotSpam={noop}
      onAskDelete={noop}
      onCancelDelete={noop}
      onRequestDelete={noop}
      onCancelDeletion={noop}
    />,
  );
}

describe("a request with no name", () => {
  const nameless = { ...list("cv_request"), results: [{ ...row("cv_request"), name: "" }] };

  it("has a readable link in the list, never an empty one", () => {
    const html = rows(nameless);
    expect(html).toMatch(/<a [^>]*>No name given<\/a>/);
    expect(html).not.toMatch(/<a [^>]*><\/a>/);
  });

  it("has a heading and a From line in the detail", () => {
    const html = renderToStaticMarkup(
      <MessageView
        message={{ ...detail("cv_request"), name: "" }}
        backHref="/desk/messages"
        backLabel="Inbox"
        pendingHref="/desk/pending"
        busy={false}
        confirming={false}
        deletion={null}
        noteText=""
        noteError=""
        onNoteText={noop}
        onMove={noop}
        onAddNote={noop}
        onLogResponse={noop}
        onToggleKept={noop}
        onNotSpam={noop}
        onAskDelete={noop}
        onCancelDelete={noop}
        onRequestDelete={noop}
        onCancelDeletion={noop}
      />,
    );
    expect(html).toContain("Message with no name given");
    expect(html).toContain("<dd>No name given</dd>");
  });
});

describe("the CV request badge in the list", () => {
  it("shows on a CV request, in words", () => {
    const html = rows(list("cv_request"));
    expect(html).toContain("CV request");
    expect(html).toContain('data-testid="kind-badge"');
  });

  it("does not show on an ordinary message, or one with no kind", () => {
    expect(rows(list("message"))).not.toContain("CV request");
    expect(rows(list())).not.toContain("kind-badge");
  });

  it("labels both kinds", () => {
    expect(KIND_LABEL).toEqual({ message: "Message", cv_request: "CV request" });
  });
});

describe("the CV request badge in the detail", () => {
  it("shows on a CV request, with its text unchanged and a reply by email as for any message", () => {
    const html = view("cv_request");
    expect(html).toContain("CV request");
    expect(html).toContain('data-testid="kind-badge"');
    expect(html).toContain("Request for a copy of the CV.");
    expect(html).toContain("Please send the accessible one.");
    expect(html).toContain("Reply by email");
    expect(html).toContain(`href="${mailtoHref("sam@example.com").replace(/&/g, "&amp;")}"`);
  });

  it("does not show on an ordinary message", () => {
    expect(view("message")).not.toContain("kind-badge");
    expect(view()).not.toContain("kind-badge");
  });
});

describe("the kind filter", () => {
  const html = (filters: Filters = NO_FILTERS) =>
    renderToStaticMarkup(<InboxFilters filters={filters} onApply={noop} />);

  it("has a labelled choice of all messages or CV requests", () => {
    const markup = html();
    expect(markup).toContain("Show");
    expect(markup).toContain(">All messages</option>");
    expect(markup).toContain(">CV requests</option>");
  });

  it("has the chosen kind selected", () => {
    expect(html({ ...NO_FILTERS, kind: "cv_request" })).toMatch(/<option value="cv_request" selected="">CV requests/);
    expect(html()).toMatch(/<option value="" selected="">All messages/);
  });

  it("counts as a filter, so Clear filters shows and an empty result says so", () => {
    const filters: Filters = { ...NO_FILTERS, kind: "cv_request" };
    expect(hasFilters(filters)).toBe(true);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(html(filters)).toContain("Clear filters");
    const none = rows({ ...list("cv_request"), results: [], count: 0 }, filters);
    expect(none).toContain("No messages match those filters.");
  });

  it("is read from ?kind= and anything but cv_request is dropped", () => {
    const from = (query: string) => {
      const params = new URLSearchParams(query);
      return filtersFrom((name) => params.get(name));
    };
    expect(from("kind=cv_request").kind).toBe("cv_request");
    expect(from("kind=message")).toEqual(NO_FILTERS);
    expect(from("kind=anything")).toEqual(NO_FILTERS);
    expect(from("kind=")).toEqual(NO_FILTERS);
  });

  it("stays in every folder and message link, and in the address", () => {
    const filters: Filters = { ...NO_FILTERS, kind: "cv_request" };
    expect(tabHref("/desk/messages", "spam", 2, filters)).toBe("/desk/messages?status=spam&kind=cv_request&page=2");
    expect(detailHref("/desk/messages", ID, "inbox", 1, filters)).toContain("kind=cv_request");
    const tabs = renderToStaticMarkup(
      <InboxTabs base="/desk/messages" tab="inbox" counts={COUNTS} filters={filters} />,
    );
    expect(tabs).toContain("kind=cv_request");
    expect(rows(list("cv_request"), filters)).toContain("kind=cv_request");
  });

  it("is sent to the API as kind, and left out when it is all", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/csrf")) return new Response(JSON.stringify({ csrf_token: "t" }), { status: 200 });
      calls.push(url);
      return new Response(JSON.stringify(list()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const inbox = inboxApi(createClient(fetcher));
    await inbox.list("inbox", 1, { ...NO_FILTERS, kind: "cv_request" });
    await inbox.list("inbox", 1, NO_FILTERS);
    expect(calls[0]).toBe("/api/v1/admin/messages?kind=cv_request");
    expect(calls[1]).toBe("/api/v1/admin/messages");
  });
});
