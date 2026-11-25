import { describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/admin/api";
import {
  checkLimit,
  checkLimits,
  EDITABLE_LIMITS,
  FIXED_LABEL,
  fixedText,
  type LimitName,
  type Limits,
  limitsApi,
  textsFrom,
} from "@/lib/admin/limits";

const at = (url: string) => new URL(url, "http://localhost");

function fakeFetch(answers: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/csrf")) {
      return new Response(JSON.stringify({ csrf_token: "t" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls, fetcher };
}

const BOUNDS: Record<LimitName, [number, number, number]> = {
  human_daily_cap: [25, 1, 200],
  spam_daily_cap: [20, 0, 200],
  per_address_per_hour: [5, 1, 50],
  per_email_per_day: [3, 1, 20],
  min_seconds: [3, 0, 30],
  max_links: [2, 0, 10],
  spam_threshold: [100, 50, 100],
  blocklist_months: [12, 1, 36],
};

function limits(): Limits {
  return {
    editable: Object.fromEntries(
      EDITABLE_LIMITS.map((name) => {
        const [value, min, max] = BOUNDS[name];
        return [name, { value, default: value, min, max }];
      }),
    ) as Limits["editable"],
    fixed: [
      { name: "vital_action_wait", value: 1440, unit: "minutes" },
      { name: "blocklist_max_entries", value: 500, unit: "count" },
    ],
  };
}

describe("the limits client", () => {
  it("reads, and saves only what changed, with PATCH", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, limits()],
      [200, limits()],
    ]);
    const client = limitsApi(createClient(fetcher));
    await client.read();
    await client.save({ max_links: 4 });
    expect(at(calls[0].url).pathname).toBe("/api/v1/admin/limits");
    expect(calls[1].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ max_links: 4 });
  });
});

describe("checking a limit", () => {
  it.each(["", " ", "1.5", "-1", "1e2", "ten", "٣", "0x10", "123456"])(
    "refuses %j as not a whole number",
    (text) => {
      expect(checkLimit(text, 0, 200)).toBe("Enter a whole number.");
    },
  );

  it("refuses numbers outside the bounds and names them", () => {
    expect(checkLimit("0", 1, 50)).toBe("Use a number from 1 to 50.");
    expect(checkLimit("51", 1, 50)).toBe("Use a number from 1 to 50.");
  });

  it("accepts both ends", () => {
    expect(checkLimit("1", 1, 50)).toBe("");
    expect(checkLimit("50", 1, 50)).toBe("");
  });
});

describe("checking all limits", () => {
  it("sends nothing when nothing changed", () => {
    const data = limits();
    expect(checkLimits(textsFrom(data), data)).toEqual({ errors: {}, changes: {} });
  });

  it("sends only the changed values, as numbers", () => {
    const data = limits();
    const texts = { ...textsFrom(data), per_email_per_day: "4", blocklist_months: " 24 " };
    expect(checkLimits(texts, data).changes).toEqual({
      per_email_per_day: 4,
      blocklist_months: 24,
    });
  });

  it("reports each bad one by name and sends none of them", () => {
    const data = limits();
    const texts = { ...textsFrom(data), spam_threshold: "49", min_seconds: "1.5" };
    const { errors, changes } = checkLimits(texts, data);
    expect(errors.spam_threshold).toBe("Use a number from 50 to 100.");
    expect(errors.min_seconds).toBe("Enter a whole number.");
    expect(changes).toEqual({});
  });

  it("lets the spam cap be zero", () => {
    const data = limits();
    expect(checkLimits({ ...textsFrom(data), spam_daily_cap: "0" }, data).changes).toEqual({
      spam_daily_cap: 0,
    });
  });
});

describe("the fixed limits", () => {
  it("has words for every name the API sends", () => {
    for (const name of [
      "public_requests_per_minute",
      "admin_requests_per_minute",
      "sign_in_failures_per_client",
      "sign_in_failures_overall",
      "sign_in_failure_window",
      "sign_in_lockout",
      "session_idle_timeout",
      "session_absolute_timeout",
      "passkey_confirmation_lasts",
      "vital_action_wait",
      "blocklist_max_entries",
    ]) {
      expect(FIXED_LABEL[name]).toBeTruthy();
    }
  });

  it("writes minutes as hours when they divide evenly", () => {
    expect(fixedText({ name: "x", value: 1440, unit: "minutes" })).toBe("24 hours");
    expect(fixedText({ name: "x", value: 60, unit: "minutes" })).toBe("1 hour");
    expect(fixedText({ name: "x", value: 45, unit: "minutes" })).toBe("45 minutes");
    expect(fixedText({ name: "x", value: 1, unit: "minutes" })).toBe("1 minute");
    expect(fixedText({ name: "x", value: 500, unit: "count" })).toBe("500");
  });
});
