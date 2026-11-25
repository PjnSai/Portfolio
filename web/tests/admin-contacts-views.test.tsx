import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ContactFields,
  ContactFilterForm,
  ContactIdentity,
  ContactRows,
  dayText,
  isDue,
  LinkableMessages,
  LinkedMessages,
} from "@/components/admin/contacts/ContactViews";
import { ContactPanelView } from "@/components/admin/inbox/ContactPanel";
import { ApiError, describeError } from "@/lib/admin/api";
import {
  type ContactDetail,
  type ContactSummary,
  checkContact,
  formFrom,
} from "@/lib/admin/contacts";
import type { MessageDetail, MessageSummary } from "@/lib/admin/inbox";

const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";
const OTHER = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const summary: ContactSummary = {
  id: ID,
  name: "Sam Recruiter",
  email: "sam@example.com",
  organisation: "Halverton Recruitment",
  tags: ["recruiter", "spring"],
  follow_up: "2026-03-01",
  created_at: "2026-02-01T10:00:00Z",
  updated_at: "2026-02-01T10:00:00Z",
};

const row: MessageSummary = {
  id: OTHER,
  name: "Sam Recruiter",
  email: "sam@example.com",
  status: "read",
  reason: "hiring",
  spam_score: 0,
  created_at: "2026-02-02T10:00:00Z",
  kept: false,
  contact_id: ID,
  snippet: "A role for you.",
};

const detail: ContactDetail = { ...summary, notes: "Met at the fair.", messages: [row] };

const noop = () => {};

function message(over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: OTHER,
    name: "Sam Recruiter",
    email: "sam@example.com",
    body: "Hello.",
    reason: "hiring",
    spam_score: 0,
    status: "read",
    created_at: "2026-02-02T10:00:00Z",
    read_at: null,
    kept: false,
    contact_id: null,
    expires_at: "2027-02-02T10:00:00Z",
    notes: [],
    ...over,
  };
}

function panel(over: Partial<Parameters<typeof ContactPanelView>[0]> = {}) {
  return renderToStaticMarkup(
    <ContactPanelView
      message={message()}
      contactsBase="/desk/contacts"
      open={false}
      form={formFrom(null)}
      errors={{}}
      busy={false}
      error=""
      onOpen={noop}
      onClose={noop}
      onChange={noop}
      onSubmit={noop}
      {...over}
    />,
  );
}

describe("the contacts list", () => {
  const listing = { results: [summary], page: 1, pages: 1, count: 1 };

  it("shows name, organisation, email, tags and the follow-up, linked to the contact", () => {
    const html = renderToStaticMarkup(
      <ContactRows
        base="/desk/contacts"
        listing={listing}
        onPage={noop}
        now={new Date("2026-03-02T00:00:00Z")}
      />,
    );
    expect(html).toContain(`href="/desk/contacts?id=${ID}"`);
    expect(html).toContain("Halverton Recruitment · sam@example.com");
    expect(html).toContain("recruiter");
    expect(html).toContain("Follow up 1 Mar 2026 · due");
  });

  it("does not call a future follow-up due", () => {
    const html = renderToStaticMarkup(
      <ContactRows
        base="/desk/contacts"
        listing={listing}
        onPage={noop}
        now={new Date("2026-02-01T00:00:00Z")}
      />,
    );
    expect(html).not.toContain("· due");
  });

  it("keeps the filters in the link and says when none match", () => {
    const filters = { q: "sam", tag: "", due: true };
    const html = renderToStaticMarkup(
      <ContactRows base="/desk/contacts" listing={listing} filters={filters} onPage={noop} />,
    );
    expect(html).toContain(`href="/desk/contacts?id=${ID}&amp;q=sam&amp;due=1"`);
    const empty = renderToStaticMarkup(
      <ContactRows
        base="/desk/contacts"
        listing={{ ...listing, results: [], count: 0 }}
        filters={filters}
        onPage={noop}
      />,
    );
    expect(empty).toContain("No contacts match those filters.");
  });

  it("explains an empty list", () => {
    const html = renderToStaticMarkup(
      <ContactRows
        base="/desk/contacts"
        listing={{ ...listing, results: [], count: 0 }}
        onPage={noop}
      />,
    );
    expect(html).toContain("No saved contacts yet");
  });

  it("shows a pager when there is more than one page", () => {
    const html = renderToStaticMarkup(
      <ContactRows
        base="/desk/contacts"
        listing={{ ...listing, pages: 3, count: 60 }}
        onPage={noop}
      />,
    );
    expect(html).toContain("Page 1 of 3");
  });
});

describe("the contacts filters", () => {
  it("has a search, a tag and a follow-up due tick", () => {
    const html = renderToStaticMarkup(
      <ContactFilterForm filters={{ q: "", tag: "", due: false }} onApply={noop} />,
    );
    expect(html).toContain('role="search"');
    expect(html).toContain("Search name, organisation or email");
    expect(html).toContain("Tag");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Follow-up due");
    expect(html).not.toContain("Clear filters");
  });

  it("offers to clear filters once some are set", () => {
    const html = renderToStaticMarkup(
      <ContactFilterForm filters={{ q: "x", tag: "", due: false }} onApply={noop} />,
    );
    expect(html).toContain("Clear filters");
  });
});

describe("one contact", () => {
  it("shows the email as text, never as a field", () => {
    const html = renderToStaticMarkup(<ContactIdentity contact={detail} />);
    expect(html).toContain("sam@example.com");
    expect(html).toContain("Email (cannot be changed)");
    expect(html).not.toContain("<input");
  });

  it("lets the owner edit organisation, tags, notes and the follow-up date", () => {
    const html = renderToStaticMarkup(
      <ContactFields prefix="c" form={formFrom(detail)} errors={{}} onChange={noop} />,
    );
    expect(html).toContain('value="Halverton Recruitment"');
    expect(html).toContain('value="recruiter, spring"');
    expect(html).toContain("Met at the fair.");
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-03-01"');
    expect(html).not.toContain('value="sam@example.com"');
  });

  it("marks a bad field and says why", () => {
    const { errors } = checkContact({ ...formFrom(detail), tags: "x".repeat(40) });
    const html = renderToStaticMarkup(
      <ContactFields prefix="c" form={formFrom(detail)} errors={errors} onChange={noop} />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Keep each tag to 30 characters.");
  });

  it("lists the linked messages with a link to each and a way to unlink", () => {
    const html = renderToStaticMarkup(
      <LinkedMessages
        messageBase="/desk/messages"
        messages={[row]}
        busy={false}
        onUnlink={noop}
      />,
    );
    expect(html).toContain(`href="/desk/messages?id=${OTHER}"`);
    expect(html).toContain("Unlink this message");
    expect(html).toContain("A role for you.");
  });

  it("says when nothing is linked", () => {
    const html = renderToStaticMarkup(
      <LinkedMessages messageBase="/desk/messages" messages={[]} busy={false} onUnlink={noop} />,
    );
    expect(html).toContain("No messages are linked");
  });

  it("offers unlinked messages from the same sender to link, and handles none", () => {
    const html = renderToStaticMarkup(
      <LinkableMessages
        messageBase="/desk/messages"
        messages={[{ ...row, contact_id: null }]}
        busy={false}
        onLink={noop}
      />,
    );
    expect(html).toContain("Link this message");
    const none = renderToStaticMarkup(
      <LinkableMessages messageBase="/desk/messages" messages={[]} busy={false} onLink={noop} />,
    );
    expect(none).toContain("No other messages from this sender");
  });

  it("reads days as the owner would", () => {
    expect(dayText(null)).toBe("none set");
    expect(dayText("2026-03-01")).toBe("1 Mar 2026");
    expect(isDue("2026-03-01", new Date("2026-03-01T23:00:00Z"))).toBe(true);
    expect(isDue(null)).toBe(false);
  });
});

describe("saving a message's sender as a contact", () => {
  it("offers a Save as contact button when the message has no contact", () => {
    const html = panel();
    expect(html).toContain("Save as contact");
    expect(html).not.toContain("Open the contact");
  });

  it("opens a form with every field optional and the name and email taken from the message", () => {
    const html = panel({ open: true });
    expect(html).toContain("copied from this message");
    expect(html.match(/\(optional/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("required");
    expect(html).toContain("Save contact");
  });

  it("links to the contact when the message has one", () => {
    const html = panel({ message: message({ contact_id: ID }) });
    expect(html).toContain(`href="/desk/contacts?id=${ID}"`);
    expect(html).toContain("Open the contact");
    expect(html).not.toContain("Save as contact");
  });

  it("shows a contact that already exists in plain words", () => {
    const text = describeError(new ApiError(409, { code: "contact_exists" }));
    expect(panel({ error: text })).toContain("There is already a saved contact");
  });

  it("explains a different sender in plain words", () => {
    const text = describeError(new ApiError(409, { code: "different_sender" }));
    expect(text).toContain("different email address");
  });
});
