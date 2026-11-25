import { describe, expect, it } from "vitest";
import { createClient, UnexpectedAnswer } from "@/lib/admin/api";
import { type Alert, alertsApi, type AlertList, kindWords } from "@/lib/admin/alerts";
import { fakeFetch } from "./fakes";

const at = (url: string) => new URL(url, "http://localhost");
const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: ID,
  at: "2026-11-25T10:00:00+00:00",
  kind: "failed_sign_ins",
  summary: "5 failed sign-ins or passkey confirmations in 15 minutes.",
  seen: false,
  ...over,
});
const list = (over: Partial<AlertList> = {}): AlertList => ({
  alerts: [alert()],
  next_before: null,
  unseen: 1,
  ...over,
});

describe("the alerts client", () => {
  it("lists with the filter and cursor, and nothing else", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, list()],
      [200, list()],
      [200, list()],
    ]);
    const client = alertsApi(createClient(fetcher));
    await client.list({});
    await client.list({ unseenOnly: true, before: ID });
    await client.count();
    expect(at(calls[0].url).search).toBe("");
    const second = at(calls[1].url).searchParams;
    expect(second.get("unseen")).toBe("1");
    expect(second.get("before")).toBe(ID);
    expect(at(calls[2].url).searchParams.get("limit")).toBe("1");
  });

  it("marks seen with a POST to the alert's own address", async () => {
    const { calls, fetcher } = fakeFetch([[200, alert({ seen: true })]]);
    const result = await alertsApi(createClient(fetcher)).markSeen(ID);
    expect(calls[0].init.method).toBe("POST");
    expect(at(calls[0].url).pathname).toBe(`/api/v1/admin/alerts/${ID}/seen`);
    expect(result.seen).toBe(true);
  });

  it("will not send an id that is not a UUID", async () => {
    const { fetcher } = fakeFetch([]);
    await expect(alertsApi(createClient(fetcher)).markSeen("../x")).rejects.toThrow();
  });

  it.each([
    ["no list", {}],
    ["a text unseen count", { alerts: [], next_before: null, unseen: "2" }],
    [
      "an alert without a summary",
      { alerts: [{ id: ID, at: "x", kind: "a", seen: false }], next_before: null, unseen: 0 },
    ],
    ["a seen flag that is text", { alerts: [{ ...alert(), seen: "no" }], next_before: null, unseen: 0 }],
  ])("refuses an answer with %s", async (_name, body) => {
    const { fetcher } = fakeFetch([[200, body]]);
    await expect(alertsApi(createClient(fetcher)).list({})).rejects.toBeInstanceOf(UnexpectedAnswer);
  });
});

describe("alert kinds in words", () => {
  it("names the five kinds and falls back for one it does not know", () => {
    for (const kind of [
      "failed_sign_ins",
      "passkey_added",
      "vital_action_requested",
      "rate_limit_storm",
      "error_spike",
    ]) {
      expect(kindWords(kind)).not.toContain("_");
    }
    expect(kindWords("something_new")).toBe("Other alert");
  });
});
