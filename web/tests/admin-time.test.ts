import { describe, expect, it } from "vitest";
import { timeLeft } from "@/lib/admin/time";

const now = new Date("2026-11-17T12:00:00Z");

describe("time left", () => {
  it.each([
    ["2026-11-18T12:00:00Z", "24 h 0 min left"],
    ["2026-11-18T11:59:00Z", "23 h 59 min left"],
    ["2026-11-17T12:05:30Z", "5 min left"],
    ["2026-11-17T12:00:20Z", "under a minute left"],
    ["2026-11-17T11:00:00Z", "time is up"],
    ["2026-11-25T12:00:00Z", "8 days left"],
  ])("%s gives %s", (until, text) => {
    expect(timeLeft(until, now)).toBe(text);
  });
});
