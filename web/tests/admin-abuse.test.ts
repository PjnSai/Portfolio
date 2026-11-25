import { describe, expect, it } from "vitest";
import { createClient, describeError, UnexpectedAnswer } from "@/lib/admin/api";
import {
  abuseApi,
  type AbuseSummary,
  barPercent,
  checkRange,
  defaultRange,
  KIND_WORDS,
  KINDS,
} from "@/lib/admin/abuse";
import { fakeFetch } from "./fakes";

const at = (url: string) => new URL(url, "http://localhost");

function summary(over: Partial<AbuseSummary> = {}): AbuseSummary {
  const kinds = [...KINDS];
  return {
    from: "2026-11-24",
    to: "2026-11-25",
    kinds,
    totals: Object.fromEntries(kinds.map((k) => [k, k === "spam" ? 5 : 0])),
    days: [
      { day: "2026-11-24", counts: Object.fromEntries(kinds.map((k) => [k, k === "spam" ? 2 : 0])) },
      { day: "2026-11-25", counts: Object.fromEntries(kinds.map((k) => [k, k === "spam" ? 3 : 0])) },
    ],
    ...over,
  };
}

describe("the abuse client", () => {
  it("reads with only the chosen range and kind in the query", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, summary()],
      [200, summary()],
    ]);
    const client = abuseApi(createClient(fetcher));
    await client.read({ from: "2026-11-01", to: "2026-11-25" });
    await client.read({ from: "2026-11-01", to: "2026-11-25", kind: "spam" });
    const first = at(calls[0].url);
    expect(first.pathname).toBe("/api/v1/admin/abuse");
    expect(first.searchParams.get("from")).toBe("2026-11-01");
    expect(first.searchParams.has("kind")).toBe(false);
    expect(at(calls[1].url).searchParams.get("kind")).toBe("spam");
  });

  it.each([
    ["no days", { days: undefined }],
    ["an unknown kind", { kinds: ["spam", "mystery"] }],
    ["a text total", { totals: { spam: "5" } }],
    ["a negative count", { totals: { spam: -1 } }],
    ["a bad day", { days: [{ day: "yesterday", counts: { spam: 1 } }] }],
  ])("refuses an answer with %s", async (_name, over) => {
    const { fetcher } = fakeFetch([[200, { ...summary(), ...over }]]);
    const client = abuseApi(createClient(fetcher));
    await expect(client.read({ from: "2026-11-24", to: "2026-11-25" })).rejects.toBeInstanceOf(
      UnexpectedAnswer,
    );
  });

  it("refuses an empty answer instead of showing nothing wrong", async () => {
    const { fetcher } = fakeFetch([[200, {}]]);
    await expect(
      abuseApi(createClient(fetcher)).read({ from: "2026-11-24", to: "2026-11-25" }),
    ).rejects.toBeInstanceOf(UnexpectedAnswer);
  });
});

describe("unexpected answers in words", () => {
  it("is said plainly, not as a generic failure", () => {
    expect(describeError(new UnexpectedAnswer())).toMatch(/not what this page expected/);
  });
});

describe("kinds in plain words", () => {
  it("has words for all ten kinds and no raw name", () => {
    expect(KINDS).toHaveLength(10);
    for (const kind of KINDS) {
      expect(KIND_WORDS[kind].label).not.toContain("_");
      expect(KIND_WORDS[kind].help.length).toBeGreaterThan(10);
    }
  });
});

describe("the range", () => {
  it("defaults to the last 30 days up to today, in UTC", () => {
    expect(defaultRange(new Date("2026-11-25T23:30:00Z"))).toEqual({
      from: "2026-10-27",
      to: "2026-11-25",
    });
  });

  it("accepts a good range and refuses bad ones in words", () => {
    expect(checkRange("2026-11-01", "2026-11-25")).toBe("");
    expect(checkRange("", "2026-11-25")).toMatch(/start date/);
    expect(checkRange("2026-11-01", "")).toMatch(/end date/);
    expect(checkRange("2026-02-30", "2026-03-01")).toMatch(/real date/);
    expect(checkRange("2026-11-25", "2026-11-01")).toMatch(/before/);
    expect(checkRange("2025-01-01", "2026-11-25")).toMatch(/366 days/);
    expect(checkRange("2025-11-25", "2026-11-25")).toBe("");
  });
});

describe("the bars", () => {
  it("scales to the busiest day and gives a visible sliver to any day with a count", () => {
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(0, 0)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
  });
});
