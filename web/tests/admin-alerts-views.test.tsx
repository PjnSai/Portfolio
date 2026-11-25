import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AlertFilter,
  AlertRows,
  AlertsNote,
  UnseenBadge,
} from "@/components/admin/security/AlertViews";
import type { Alert } from "@/lib/admin/alerts";

const noop = () => {};
const A = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";
const B = "4a3d9b0f-2c8e-4d66-8b1f-7e2a3c4d5e6f";

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: A,
  at: "2026-11-25T10:30:00+00:00",
  kind: "rate_limit_storm",
  summary: "100 requests refused by a rate limit in 10 minutes.",
  seen: false,
  ...over,
});

const rows = (alerts: Alert[], busy: string | null = null) =>
  renderToStaticMarkup(<AlertRows alerts={alerts} busyId={busy} onSeen={noop} />);

describe("the alert rows", () => {
  it("shows the time, the kind in words and the summary", () => {
    const html = rows([alert()]);
    expect(html).toContain("25 Nov 2026");
    expect(html).toContain("<time");
    expect(html).toContain('dateTime="2026-11-25T10:30:00+00:00"');
    expect(html).toContain("Many requests turned away");
    expect(html).not.toContain(">rate_limit_storm<");
    expect(html).toContain("100 requests refused by a rate limit in 10 minutes.");
  });

  it("has a Mark seen button for an unseen alert only, and says Seen for the rest", () => {
    const html = rows([alert(), alert({ id: B, seen: true, kind: "failed_sign_ins" })]);
    expect((html.match(/Mark seen/g) ?? []).length).toBe(1);
    expect(html).toContain("Seen");
    expect(html).toContain("Unseen");
  });

  it("ties the button to its alert's summary, so it is not just Mark seen", () => {
    const html = rows([alert()]);
    expect(html).toContain(`aria-describedby="alert-summary-${A}"`);
    expect(html).toContain(`id="alert-summary-${A}"`);
  });

  it("makes each alert focusable by script, so focus can be placed after Mark seen", () => {
    expect(rows([alert()])).toContain(`id="alert-${A}"`);
    expect(rows([alert()])).toContain('tabindex="-1"');
  });

  it("disables the button while that alert is being marked", () => {
    expect(rows([alert()], A)).toMatch(/<button[^>]*disabled=""/);
    expect(rows([alert()], B)).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("falls back to Other alert for a kind it does not know", () => {
    expect(rows([alert({ kind: "mystery" })])).toContain("Other alert");
  });

  it("renders text, not markup, from a summary", () => {
    const html = rows([alert({ summary: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the filter", () => {
  it("is a labelled checkbox called Unseen only", () => {
    const html = renderToStaticMarkup(<AlertFilter unseenOnly={false} onChange={noop} />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Unseen only");
    expect(html).not.toContain("checked");
    expect(renderToStaticMarkup(<AlertFilter unseenOnly onChange={noop} />)).toContain("checked");
  });
});

describe("the note", () => {
  it("says alerts are in the admin only and a notice outside the site is separate", () => {
    const html = renderToStaticMarkup(<AlertsNote />);
    expect(html).toMatch(/only in this admin/);
    expect(html).toMatch(/notice outside the site/);
    expect(html).toMatch(/log/);
    expect(html).toMatch(/email/);
  });
});

describe("the unseen count on the navigation link", () => {
  it("shows a number, and says it in words for a screen reader", () => {
    const html = renderToStaticMarkup(<UnseenBadge count={3} />);
    expect(html).toContain('data-testid="alerts-count"');
    expect(html).toContain(">3<");
    expect(html).toContain("3 unseen");
  });

  it("shows nothing for none", () => {
    expect(renderToStaticMarkup(<UnseenBadge count={0} />)).toBe("");
  });

  it("says so when the count could not be read, instead of looking like none", () => {
    const html = renderToStaticMarkup(<UnseenBadge count={null} />);
    expect(html).toContain(">?<");
    expect(html).toContain("could not be checked");
  });
});
