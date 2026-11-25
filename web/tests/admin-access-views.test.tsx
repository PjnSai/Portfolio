import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccessNotes,
  PrincipalCard,
  SuperuserWarning,
} from "@/components/admin/security/AccessViews";
import type { Principal } from "@/lib/admin/access";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    id: "deploy_pipeline",
    name: "Deploy pipeline",
    can: ["Build the images and deploy a new version of the API."],
    cannot: ["Read content or messages.", "Deploy without the manual approval."],
    credential: "A short-lived Google pass for each run.",
    expiry: "Each pass lasts one pipeline run.",
    expires: null,
    last_used: null,
    checked_by_app: false,
    revocable_here: false,
    note: "Not checked by the app. Set up with the deploy pipeline (Phase 7).",
    ...over,
  };
}

const card = (entry: Principal) => renderToStaticMarkup(<PrincipalCard principal={entry} />);

describe("a principal's card", () => {
  const html = card(principal());

  it("shows the name, what it can do, what it cannot, its credential and expiry", () => {
    expect(html).toContain("Deploy pipeline");
    expect(html).toContain("Build the images");
    expect(html).toContain("Read content or messages.");
    expect(html).toContain("Deploy without the manual approval.");
    expect(html).toContain("A short-lived Google pass for each run.");
    expect(html).toContain("Each pass lasts one pipeline run.");
    expect(html).toMatch(/Can/);
    expect(html).toMatch(/Cannot/);
  });

  it("is a labelled section with a heading, can and cannot as lists", () => {
    expect(html).toContain("<section");
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("<h2");
    expect((html.match(/<ul/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("marks one the app cannot inspect, and does not say 'never used' about it", () => {
    expect(html).toContain("Not checked by the app");
    expect(html).toContain("Not known");
    expect(html).not.toContain("never");
  });

  it("does not use the label for one the app does check", () => {
    const checked = card(
      principal({ checked_by_app: true, last_used: "2026-11-20T09:30:00+00:00", note: undefined }),
    );
    expect(checked).not.toContain("Not checked by the app");
    expect(checked).toContain("20 Nov 2026");
  });

  it("says never for a checked principal that has not been used", () => {
    expect(card(principal({ checked_by_app: true, note: undefined }))).toContain("never");
  });

  it("shows whether a secret is set, never the secret", () => {
    expect(card(principal({ configured: true, checked_by_app: true }))).toContain("Set");
    expect(card(principal({ configured: false, checked_by_app: true }))).toContain("Not set");
  });

  it("shows the expiry time when there is one", () => {
    expect(card(principal({ expires: "2026-12-01T10:00:00+00:00" }))).toContain("1 Dec 2026");
  });
});

describe("the owner's sessions and passkeys", () => {
  const sessions = principal({
    id: "owner_sessions",
    name: "Your signed-in sessions",
    checked_by_app: true,
    revocable_here: true,
    note: undefined,
    items: [
      {
        signed_in_at: "2026-11-25T08:00:00+00:00",
        last_used: "2026-11-25T09:00:00+00:00",
        expires: "2026-11-25T16:00:00+00:00",
        elevated_until: null,
        current: true,
      },
      {
        signed_in_at: "2026-11-24T08:00:00+00:00",
        last_used: "2026-11-24T09:00:00+00:00",
        expires: "2026-11-24T16:00:00+00:00",
        elevated_until: null,
        current: false,
      },
    ],
  });
  const passkeys = principal({
    id: "owner_passkeys",
    name: "Your passkeys",
    checked_by_app: true,
    revocable_here: true,
    note: undefined,
    items: [
      {
        id: "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e",
        name: "Laptop",
        created_at: "2026-10-01T10:00:00+00:00",
        last_used: null,
      },
    ],
  });

  it("lists each session, marks this one, and links to the existing sign-out flow", () => {
    const html = card(sessions);
    expect(html).toContain("This session");
    expect(html).toContain("25 Nov 2026");
    expect(html).toContain("24 Nov 2026");
    expect(html).toContain('href="/desk/security"');
    expect(html).toMatch(/Sign out everywhere/);
  });

  it("lists each passkey by its name and links to the existing remove flow", () => {
    const html = card(passkeys);
    expect(html).toContain("Laptop");
    expect(html).toContain('href="/desk/security"');
    expect(html).toMatch(/remove a passkey/i);
  });

  it("shows no identifier for a session and none for a passkey", () => {
    const html = card(sessions) + card(passkeys);
    expect(html).not.toContain("3f2c8a9e");
    expect(html).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("gives no revoke link to a principal that cannot be revoked in the app", () => {
    expect(card(principal())).not.toContain("/desk/security");
    expect(card(principal())).toMatch(/docs\/ACCESS\.md/);
  });
});

describe("a database role", () => {
  it("shows the warning in its own card", () => {
    const html = card(
      principal({
        id: "database_app_rw",
        name: "Website database role",
        checked_by_app: true,
        note: undefined,
        warning: "The API is connected as a superuser, not as this role.",
      }),
    );
    expect(html).toContain("The API is connected as a superuser, not as this role.");
    expect(html).toContain('role="alert"');
  });
});

describe("the superuser warning", () => {
  it("is a prominent alert that says what to do", () => {
    const html = renderToStaticMarkup(<SuperuserWarning />);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/superuser/);
    expect(html).toMatch(/never be the case in production/);
  });
});

describe("the notes", () => {
  it("says a quarterly review is the plan, points to docs/ACCESS.md and stores nothing", () => {
    const html = renderToStaticMarkup(<AccessNotes />);
    expect(html).toMatch(/quarterly review/i);
    expect(html).toContain("docs/ACCESS.md");
    expect(html).toMatch(/outside the app/);
    expect(html).not.toMatch(/Last reviewed/i);
  });
});
