import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InboxTabs,
  MessageRows,
  MessageView,
  type MessageViewProps,
} from "@/components/admin/inbox/InboxViews";
import { createClient } from "@/lib/admin/api";
import {
  type Counts,
  detailHref,
  inboxApi,
  type MessageDetail,
  type MessageList,
  type MessageStatus,
  mailtoHref,
  movesFrom,
  pageFrom,
  tabCount,
  tabFrom,
  tabHref,
} from "@/lib/admin/inbox";

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls, fetcher };
}

const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";
const COUNTS: Counts = { new: 2, read: 3, replied: 1, archived: 4, spam: 5 };

function message(over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: ID,
    name: "Sam Recruiter",
    email: "sam@example.com",
    body: "Hello there.\nSecond line.",
    status: "new",
    created_at: "2026-03-01T10:00:00Z",
    read_at: null,
    kept: false,
    expires_at: "2026-05-30T10:00:00Z",
    notes: [],
    ...over,
  };
}

function view(over: Partial<MessageViewProps> = {}) {
  const noop = () => {};
  return renderToStaticMarkup(
    <MessageView
      message={message()}
      backHref="/desk/messages"
      backLabel="Inbox"
      busy={false}
      confirming={false}
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
      onDelete={noop}
      {...over}
    />,
  );
}

function listing(over: Partial<MessageList> = {}): MessageList {
  return {
    results: [
      {
        id: ID,
        name: "Sam Recruiter",
        email: "sam@example.com",
        status: "new",
        created_at: "2026-03-01T10:00:00Z",
        kept: false,
        snippet: "Hello there.",
      },
    ],
    page: 1,
    pages: 1,
    count: 1,
    counts: COUNTS,
    ...over,
  };
}

describe("inbox calls", () => {
  it("lists by tab and page, leaving out what is the default", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, listing()],
      [200, listing()],
      [200, listing()],
    ]);
    const inbox = inboxApi(createClient(fetcher));

    await inbox.list("inbox", 1);
    await inbox.list("spam", 1);
    await inbox.list("read", 3);

    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/admin/messages",
      "/api/v1/admin/messages?status=spam",
      "/api/v1/admin/messages?status=read&page=3",
    ]);
    expect(calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  it("opens a message with a read-only request", async () => {
    const { calls, fetcher } = fakeFetch([[200, message()]]);

    await inboxApi(createClient(fetcher)).open(ID);

    expect(calls[0].url).toBe(`/api/v1/admin/messages/${ID}`);
    expect(calls[0].init.method).toBe("GET");
  });

  it("sends each action to its route with the CSRF token", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, { csrf_token: "t" }],
      ...Array.from({ length: 7 }, (): [number, unknown] => [200, {}]),
    ]);
    const inbox = inboxApi(createClient(fetcher));

    await inbox.setStatus(ID, "archived");
    await inbox.addNote(ID, "Rang back");
    await inbox.logResponse(ID, "Sent the CV");
    await inbox.logResponse(ID, "");
    await inbox.setKept(ID, true);
    await inbox.notSpam(ID);
    await inbox.remove(ID);

    const sent = calls.slice(1).map((c) => [c.url, c.init.body]);
    const at = (path: string) => `/api/v1/admin/messages/${ID}/${path}`;
    expect(sent).toEqual([
      [at("status"), '{"status":"archived"}'],
      [at("notes"), '{"text":"Rang back"}'],
      [at("responded"), '{"text":"Sent the CV"}'],
      [at("responded"), "{}"],
      [at("keep"), '{"kept":true}'],
      [at("not-spam"), "{}"],
      [at("delete"), "{}"],
    ]);
    for (const call of calls.slice(1)) {
      expect(call.init.method).toBe("POST");
      expect(new Headers(call.init.headers).get("X-CSRF-Token")).toBe("t");
    }
  });
});

describe("tabs and addresses", () => {
  it("reads the tab and page from the query, with safe defaults", () => {
    expect(tabFrom("spam")).toBe("spam");
    expect(tabFrom("all")).toBe("inbox");
    expect(tabFrom("<script>")).toBe("inbox");
    expect(tabFrom(null)).toBe("inbox");
    expect(pageFrom("3")).toBe(3);
    for (const bad of ["0", "-1", "abc", "1.5", "", null, "9999999"]) {
      expect(pageFrom(bad)).toBe(1);
    }
  });

  it("builds addresses that keep the tab and page", () => {
    expect(tabHref("/desk/messages", "inbox")).toBe("/desk/messages");
    expect(tabHref("/desk/messages", "spam")).toBe(
      "/desk/messages?status=spam",
    );
    expect(tabHref("/desk/messages", "read", 2)).toBe(
      "/desk/messages?status=read&page=2",
    );
    expect(detailHref("/desk/messages", ID, "inbox", 1)).toBe(
      `/desk/messages?id=${ID}`,
    );
    expect(detailHref("/desk/messages", ID, "spam", 2)).toBe(
      `/desk/messages?id=${ID}&status=spam&page=2`,
    );
  });

  it("counts the inbox as everything except spam", () => {
    expect(tabCount(COUNTS, "inbox")).toBe(10);
    expect(tabCount(COUNTS, "spam")).toBe(5);
    expect(tabCount(COUNTS, "new")).toBe(2);
  });

  it("offers the same moves as the API allows", () => {
    const allowed: Record<MessageStatus, string[]> = {
      new: ["read", "replied", "archived", "spam"],
      read: ["new", "replied", "archived", "spam"],
      replied: ["read", "archived", "spam"],
      archived: ["new", "read", "replied", "spam"],
      spam: [],
    };
    for (const [status, moves] of Object.entries(allowed)) {
      expect([...movesFrom(status as MessageStatus)]).toEqual(moves);
    }
  });
});

describe("Reply link", () => {
  it("is a mailto: to the sender with a fixed subject and nothing from the message", () => {
    const href = mailtoHref("sam@example.com");
    expect(href).toBe("mailto:sam@example.com?subject=Re%3A%20your%20message");
    expect(href).not.toContain("body=");
  });

  it("encodes an address so it cannot add a header or a recipient", () => {
    const href = mailtoHref("a?cc=x@evil.test&b#c@example.com");
    expect(
      href.startsWith(
        "mailto:a%3Fcc%3Dx@evil.test%26b%23c@example.com?subject=",
      ),
    ).toBe(true);
    expect(href.split("?").length).toBe(2);
  });
});

describe("list markup", () => {
  it("labels the folders, marks the current one and shows the counts", () => {
    const html = renderToStaticMarkup(
      <InboxTabs base="/desk/messages" tab="spam" counts={COUNTS} />,
    );
    expect(html).toContain('aria-label="Message folders"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Spam<span[^>]*>5<\/span>/);
    expect(html).toContain('href="/desk/messages?status=read"');
    expect(html).toContain(">10<");
  });

  it("shows folders without counts until they have loaded", () => {
    const html = renderToStaticMarkup(
      <InboxTabs base="/desk/messages" tab="inbox" counts={null} />,
    );
    expect(html).toContain("Inbox");
    expect(html).not.toContain("font-mono");
  });

  it("lists each message with a link, its state in words and its date", () => {
    const html = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={listing({
          results: [{ ...listing().results[0], kept: true }],
        })}
        tab="inbox"
        onPage={() => {}}
      />,
    );
    expect(html).toContain('data-testid="message-row"');
    expect(html).toContain(`href="/desk/messages?id=${ID}"`);
    expect(html).toContain(">Sam Recruiter</a>");
    expect(html).toContain("New");
    expect(html).toContain("Kept");
    expect(html).toContain("Hello there.");
  });

  it("keeps the tab and page in the link to a message", () => {
    const html = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={listing({ page: 2, pages: 3 })}
        tab="read"
        onPage={() => {}}
      />,
    );
    expect(html).toContain(
      `href="/desk/messages?id=${ID}&amp;status=read&amp;page=2"`,
    );
    expect(html).toContain("Page 2 of 3");
  });

  it("says so when a folder is empty, and explains the spam folder", () => {
    const empty = listing({ results: [], count: 0 });
    const inbox = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={empty}
        tab="inbox"
        onPage={() => {}}
      />,
    );
    expect(inbox).toContain("No messages yet.");
    const spam = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={empty}
        tab="spam"
        onPage={() => {}}
      />,
    );
    expect(spam).toContain("Nothing has been held back.");
  });

  it("explains a quarantined list and marks each row as spam in words", () => {
    const html = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={listing({
          results: [{ ...listing().results[0], status: "spam" }],
        })}
        tab="spam"
        onPage={() => {}}
      />,
    );
    expect(html).toContain("held back by the spam checks");
    expect(html).toContain("Spam (held back)");
  });

  it("shows sender text as text, never as markup", () => {
    const html = renderToStaticMarkup(
      <MessageRows
        base="/desk/messages"
        listing={listing({
          results: [
            {
              ...listing().results[0],
              name: "<img src=x onerror=alert(1)>",
              snippet: "<script>alert(1)</script>",
            },
          ],
        })}
        tab="inbox"
        onPage={() => {}}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("detail markup", () => {
  it("shows the sender, an unverified email, the message and a labelled note box", () => {
    const html = view();
    expect(html).toContain("Message from Sam Recruiter");
    expect(html).toContain("Email (not verified)");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("Hello there.\nSecond line.");
    expect(html).toMatch(/<label for="note-text">/);
    expect(html).toContain('id="note-text"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain("Notes cannot be edited or removed.");
  });

  it("has a Reply link that is a mailto: to the sender", () => {
    const html = view();
    expect(html).toContain(
      'href="mailto:sam@example.com?subject=Re%3A%20your%20message"',
    );
    expect(html).toContain(">Reply by email</a>");
  });

  it("offers only the moves the API allows", () => {
    const labels = (status: MessageStatus) => {
      const html = view({ message: message({ status }) });
      return [
        "Mark as new",
        "Mark as read",
        "Mark as replied",
        "Archive",
        "Mark as spam",
      ].filter((label) => html.includes(`>${label}</button>`));
    };
    expect(labels("new")).toEqual([
      "Mark as read",
      "Mark as replied",
      "Archive",
      "Mark as spam",
    ]);
    expect(labels("replied")).not.toContain("Mark as new");
  });

  it("offers Not spam, and no reply or response, for a quarantined message", () => {
    const html = view({ message: message({ status: "spam" }) });
    expect(html).toContain(">Not spam</button>");
    expect(html).toContain("held back by the spam checks");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain(">Log response</button>");
    expect(html).not.toContain(">Mark as read</button>");
  });

  it("does not offer Not spam for a message that is not spam", () => {
    expect(view()).not.toContain("Not spam");
  });

  it("shows the notes oldest first with their kind in words", () => {
    const html = view({
      message: message({
        notes: [
          {
            id: "a",
            kind: "note",
            text: "Rang back",
            created_at: "2026-03-02T09:00:00Z",
          },
          {
            id: "b",
            kind: "responded_with_details",
            text: "Sent the CV",
            created_at: "2026-03-03T09:00:00Z",
          },
        ],
      }),
    });
    expect(html.indexOf("Rang back")).toBeLessThan(html.indexOf("Sent the CV"));
    expect(html).toContain("Note ·");
    expect(html).toContain("Responded with details ·");
    expect(html).toContain('data-testid="note"');
    expect(view()).toContain("No notes yet.");
  });

  it("asks before deleting: the question appears only when asked", () => {
    const before = view();
    expect(before).toContain(">Delete</button>");
    expect(before).not.toContain("Delete this message for good?");
    const asking = view({ confirming: true });
    expect(asking).toContain('role="group"');
    expect(asking).toContain("Delete this message for good?");
    expect(asking).toContain(">Delete for good</button>");
    expect(asking).toContain(">Keep it</button>");
    expect(asking).not.toContain(">Delete</button>");
  });

  it("shows keep as a pressed state with words", () => {
    expect(view()).toContain('aria-pressed="false"');
    expect(view()).toContain("Keep this message");
    const kept = view({ message: message({ kept: true }) });
    expect(kept).toContain('aria-pressed="true"');
    expect(kept).toContain("Kept: it stays until you delete it.");
  });

  it("ties a note error to the note box and does not rely on colour", () => {
    const html = view({ noteError: "Write a note first." });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="note-hint note-error"');
    expect(html).toContain("Write a note first.");
  });

  it("disables the actions while one is running", () => {
    const html = view({ busy: true });
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("shows sender text as text, never as markup", () => {
    const html = view({
      message: message({
        name: "<b>Bold</b>",
        body: "<script>alert(1)</script>",
        notes: [
          {
            id: "a",
            kind: "note",
            text: "<img src=x>",
            created_at: "2026-03-02T09:00:00Z",
          },
        ],
      }),
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Bold");
    expect(html).toContain("&lt;script&gt;");
  });
});
