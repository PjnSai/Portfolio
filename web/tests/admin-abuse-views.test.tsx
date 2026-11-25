import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AbuseDays,
  AbuseFilters,
  AbuseTotals,
  CountsOnlyNote,
} from "@/components/admin/security/AbuseViews";
import { type AbuseSummary, KINDS } from "@/lib/admin/abuse";

const noop = () => {};
const words = (html: string) => html.replace(/<[^>]*>/g, " ");

function zeroes(over: Record<string, number> = {}) {
  return { ...Object.fromEntries(KINDS.map((k) => [k, 0])), ...over };
}

function summary(over: Partial<AbuseSummary> = {}): AbuseSummary {
  return {
    from: "2026-11-23",
    to: "2026-11-25",
    kinds: [...KINDS],
    totals: zeroes({ spam: 5, login_failed: 1 }),
    days: [
      { day: "2026-11-23", counts: zeroes() },
      { day: "2026-11-24", counts: zeroes({ spam: 2 }) },
      { day: "2026-11-25", counts: zeroes({ spam: 3, login_failed: 1 }) },
    ],
    ...over,
  };
}

describe("the filters", () => {
  const html = renderToStaticMarkup(
    <AbuseFilters
      from="2026-10-27"
      to="2026-11-25"
      kind=""
      error=""
      busy={false}
      onChange={noop}
      onSubmit={noop}
    />,
  );

  it("has labelled date fields and a kind choice listing every kind in words", () => {
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-10-27"');
    expect(html).toContain("From");
    expect(html).toContain("To");
    expect(html).toContain("All kinds");
    expect(html).toContain("Held back as spam");
    expect(words(html)).not.toMatch(/bspamb(?! )/);
    expect(words(html)).not.toContain("login_failed");
  });

  it("shows a range problem as an alert tied to the form", () => {
    const bad = renderToStaticMarkup(
      <AbuseFilters
        from="2026-11-25"
        to="2026-11-01"
        kind=""
        error="The start date must be before the end date, or the same day."
        busy={false}
        onChange={noop}
        onSubmit={noop}
      />,
    );
    expect(bad).toContain('role="alert"');
    expect(bad).toContain("must be before the end date");
  });
});

describe("the totals", () => {
  it("lists each kind in words with its total, and the overall total", () => {
    const html = renderToStaticMarkup(<AbuseTotals summary={summary()} />);
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain("Held back as spam");
    expect(html).toMatch(/Held back as spam<\/th><td[^>]*>5</);
    expect(html).toMatch(/Failed sign-in<\/th><td[^>]*>1</);
    expect(html).toMatch(/All kinds<\/th><td[^>]*>6</);
    expect(words(html)).not.toContain("login_failed");
  });

  it("shows zero for a kind with none, not a blank", () => {
    const html = renderToStaticMarkup(<AbuseTotals summary={summary()} />);
    expect(html).toMatch(/Blocked sender<\/th><td[^>]*>0</);
  });

  it("shows only the chosen kind when one is asked for", () => {
    const one = summary({ kinds: ["spam"], totals: { spam: 5 } });
    const html = renderToStaticMarkup(<AbuseTotals summary={one} />);
    expect(html).toContain("Held back as spam");
    expect(html).not.toContain("Blocked sender");
  });
});

describe("the days", () => {
  const html = renderToStaticMarkup(<AbuseDays summary={summary()} />);

  it("is a table with a row for every day, zero days included", () => {
    expect(html).toContain("<caption");
    expect((html.match(/<tr/g) ?? []).length).toBe(4);
    expect(html).toContain("23 Nov 2026");
    expect(html).toContain("25 Nov 2026");
  });

  it("says each day's counts in words and draws a bar that screen readers skip", () => {
    expect(html).toContain("Held back as spam 3");
    expect(html).toContain("Failed sign-in 1");
    expect(html).toContain("None");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("sizes bars against the busiest day without a style attribute", () => {
    expect(html).not.toContain("style=");
    expect(html).toContain('width="100%"');
    expect(html).toContain('width="50%"');
  });

  it("draws no bar width at all when every day is zero", () => {
    const quiet = renderToStaticMarkup(
      <AbuseDays
        summary={summary({
          totals: zeroes(),
          days: [{ day: "2026-11-25", counts: zeroes() }],
        })}
      />,
    );
    expect(quiet).not.toContain('width="0%"');
    expect(quiet).toContain("None");
  });
});

describe("the note", () => {
  it("says these are counts only", () => {
    const html = renderToStaticMarkup(<CountsOnlyNote />);
    expect(html).toContain("counts only");
    expect(html).toMatch(/no addresses/i);
    expect(html).toMatch(/messages/);
  });
});
