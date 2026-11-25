import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingAction } from "@/components/admin/AdminApp";
import { EraseView } from "@/components/admin/inbox/EraseEverything";
import { describeAction, PendingRow } from "@/components/admin/PendingRow";

const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";
const noop = () => {};
const NOW = new Date("2026-06-01T12:00:00Z");

function view(over: Partial<Parameters<typeof EraseView>[0]> = {}) {
  return renderToStaticMarkup(
    <EraseView
      alsoBlock={false}
      busy={false}
      error=""
      requested={null}
      pendingHref="/desk/pending"
      onAlsoBlock={noop}
      onSubmit={noop}
      {...over}
    />,
  );
}

function action(over: Partial<PendingAction> = {}): PendingAction {
  return {
    id: ID,
    kind: "erase_sender",
    target: { also_block: false, messages: 3, notes: 2, contacts: 1 },
    state: "waiting",
    requested_at: "2026-06-01T10:00:00Z",
    execute_after: "2026-06-02T10:00:00Z",
    expires_at: "2026-06-09T10:00:00Z",
    ...over,
  };
}

function row(over: Partial<PendingAction> = {}) {
  return renderToStaticMarkup(
    <PendingRow action={action(over)} now={NOW} onCancel={noop} onRun={noop} />,
  );
}

/** The first element in a tree whose children include this text. */
function find(node: ReactNode, text: string): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null;
  const props = node.props as { children?: ReactNode };
  const kids = [props.children].flat() as ReactNode[];
  if (kids.includes(text)) return node as ReactElement<Record<string, unknown>>;
  for (const kid of kids) {
    const found = find(kid, text);
    if (found) return found;
  }
  return null;
}

describe("the delete-everything button", () => {
  it("shows the owner's warning next to the button", () => {
    const html = view();
    expect(html).toContain(
      "Without &#x27;also block&#x27;, this also removes the block on this address if there is one.",
    );
    expect(html).toContain("Delete everything about this email");
  });

  it("has the also-block tick, off unless the owner turns it on", () => {
    expect(view()).toContain("Also block this sender");
    expect(view()).not.toContain("checked");
    expect(view({ alsoBlock: true })).toContain("checked");
  });

  it("says it asks for a passkey and waits 24 hours", () => {
    const html = view();
    expect(html).toContain("passkey");
    expect(html).toContain("24 hours");
    expect(html).toContain("cancel");
  });

  it("shows nothing about a request until one was made", () => {
    expect(view()).not.toContain("erase-requested");
  });

  it("shows what the API stored: counts, the choice, the wait and how to cancel", () => {
    const html = view({
      requested: { also_block: true, messages: 3, notes: 2, contacts: 1 },
    });
    expect(html).toContain("3 messages, 2 notes and 1 saved contact");
    expect(html).toContain("also keep the sender blocked");
    expect(html).toContain("waits 24 hours");
    expect(html).toContain("cancel it");
    expect(html).toContain('href="/desk/pending"');
  });

  it("says when the existing block would go too", () => {
    const html = view({
      requested: { also_block: false, messages: 1, notes: 0, contacts: 0 },
    });
    expect(html).toContain("1 message, 0 notes and 0 saved contacts");
    expect(html).toContain("any existing block on this address goes too");
  });

  it("shows a refusal in words", () => {
    expect(view({ error: "Confirm with your passkey first." })).toContain(
      "Confirm with your passkey first.",
    );
  });

  it("disables the button while asking", () => {
    expect(view({ busy: true })).toMatch(/<button[^>]*disabled/);
  });
});

describe("the pending actions page for delete-everything", () => {
  it("says it in words with the counts, not the raw kind", () => {
    const html = row();
    expect(html).toContain("Delete everything about one email address");
    expect(html).toContain("3 messages, 2 notes and 1 saved contact");
    expect(html).not.toContain("erase_sender");
  });

  it("says whether it also blocks", () => {
    expect(row()).toContain("any existing block on this address goes too");
    const blocking = row({
      target: { also_block: true, messages: 1, notes: 0, contacts: 0 },
    });
    expect(blocking).toContain("also keep the sender blocked");
    expect(blocking).toContain("1 message, 0 notes");
  });

  it("never shows a hash or the raw target", () => {
    const html = row({
      target: {
        also_block: false,
        messages: 1,
        notes: 0,
        contacts: 0,
        email_hash: "a".repeat(64),
      },
    });
    expect(html).not.toContain("a".repeat(64));
    expect(html).not.toContain("also_block");
  });

  it("falls back to plain words for a target of the wrong shape", () => {
    const html = row({ target: { messages: "many" } });
    expect(html).toContain("Delete everything about one email address");
    expect(html).not.toContain("It will remove");
  });

  it("keeps the timing and offers cancel", () => {
    const html = row();
    expect(html).toContain("Can run in");
    expect(html).toContain("Cancel this action");
    expect(html).not.toContain("Run now");
    expect(row({ state: "ready" })).toContain("Run now");
  });

  it("cancel calls the cancel handler", () => {
    const onCancel = vi.fn();
    const tree = PendingRow({ action: action(), now: NOW, onCancel, onRun: noop });
    const cancel = find(tree, "Cancel this action");
    expect(cancel).not.toBeNull();
    (cancel?.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("still words the other kinds as before", () => {
    expect(describeAction(action({ kind: "revoke_passkey", target: {} }))).toBe(
      "Remove a passkey",
    );
    expect(describeAction(action({ kind: "permanent_delete", target: { entity: "message" } }))).toBe(
      "Delete a message for good",
    );
  });
});
