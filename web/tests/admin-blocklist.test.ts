import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, describeError } from "@/lib/admin/api";
import {
  type BlockEntry,
  blocklistApi,
  checkBlockEmail,
  checkNote,
  isBlocking,
  isFull,
  sizeText,
} from "@/lib/admin/blocklist";
import {
  ERASE_WARNING,
  eraseApi,
  eraseRequested,
  eraseSummary,
  isEraseTarget,
} from "@/lib/admin/erase";

const at = (url: string) => new URL(url, "http://localhost");

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: Array<[number, unknown]>) {
  const calls: Call[] = [];
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

const ID = "3f2c8a9e-1b7d-4c55-9a0e-6d1f2b3c4d5e";

function setup(...answers: Array<[number, unknown]>) {
  const { calls, fetcher } = fakeFetch(answers);
  const client = createClient(fetcher);
  return { calls, block: blocklistApi(client), erase: eraseApi(client) };
}

function sent(call: Call) {
  return [call.init.method, at(call.url).pathname, JSON.parse(String(call.init.body ?? "{}"))];
}

describe("the blocklist client", () => {
  it("reads the list", async () => {
    const { calls, block } = setup([200, { entries: [], active: 0, max_entries: 500 }]);
    await block.list();
    expect(sent(calls[0]).slice(0, 2)).toEqual(["GET", "/api/v1/admin/blocklist"]);
  });

  it("adds with the address kept only when asked, and no empty note", async () => {
    const { calls, block } = setup([201, {}], [201, {}]);
    await block.add(" spam@example.org ", { note: " ", keepAddress: false });
    await block.add("spam@example.org", { note: "chased us", keepAddress: true });
    expect(sent(calls[0])).toEqual([
      "POST",
      "/api/v1/admin/blocklist",
      { email: "spam@example.org", keep_address: false },
    ]);
    expect(sent(calls[1])[2]).toEqual({
      email: "spam@example.org",
      note: "chased us",
      keep_address: true,
    });
  });

  it("removes, renews and blocks from a message", async () => {
    const { calls, block } = setup([200, {}], [200, {}], [200, {}]);
    await block.remove(ID);
    await block.renew(ID);
    await block.blockMessage(ID, { note: "", keepAddress: false });
    expect(calls.map((c) => sent(c))).toEqual([
      ["POST", `/api/v1/admin/blocklist/${ID}/remove`, {}],
      ["POST", `/api/v1/admin/blocklist/${ID}/renew`, {}],
      ["POST", `/api/v1/admin/messages/${ID}/block`, { keep_address: false }],
    ]);
  });
});

describe("blocklist checks", () => {
  it("allows a note up to 200 characters with no @", () => {
    expect(checkNote("")).toBe("");
    expect(checkNote("x".repeat(200))).toBe("");
    expect(checkNote("x".repeat(201))).toMatch(/200/);
    expect(checkNote("write to a@b.c")).toBe("Leave email addresses out of notes.");
  });

  it("wants a full address", () => {
    expect(checkBlockEmail("")).toBeTruthy();
    expect(checkBlockEmail("no-at-sign")).toBeTruthy();
    expect(checkBlockEmail("a b@c.org")).toBeTruthy();
    expect(checkBlockEmail("a@b.org")).toBe("");
  });

  it("says how full the list is and says so in plain words when it is", () => {
    const listing = { entries: [], active: 500, max_entries: 500 };
    expect(sizeText({ ...listing, active: 12 })).toBe("12 of 500 places in use");
    expect(isFull(listing)).toBe(true);
    expect(isFull({ ...listing, active: 499 })).toBe(false);
    expect(describeError(new ApiError(409, { code: "blocklist_full" }))).toMatch(/blocklist is full/);
  });

  it("tells a blocking entry from an expired one", () => {
    const entry = { expires_at: "2026-06-01T00:00:00Z" } as BlockEntry;
    expect(isBlocking(entry, new Date("2026-05-31T00:00:00Z"))).toBe(true);
    expect(isBlocking(entry, new Date("2026-06-02T00:00:00Z"))).toBe(false);
  });
});

describe("delete everything about an email", () => {
  const target = { also_block: false, messages: 3, notes: 1, contacts: 1 };

  it("asks for the vital action with the origin and the choice", async () => {
    const { calls, erase } = setup([201, {}], [201, {}]);
    await erase.request({ message: ID }, true);
    await erase.request({ contact: ID }, false);
    expect(sent(calls[0])).toEqual([
      "POST",
      "/api/v1/admin/vital-actions/request",
      { kind: "erase_sender", payload: { message: ID, also_block: true } },
    ]);
    expect(sent(calls[1])[2].payload).toEqual({ contact: ID, also_block: false });
  });

  it("states the warning in the owner's words", () => {
    expect(ERASE_WARNING).toBe(
      "Without 'also block', this also removes the block on this address if there is one.",
    );
  });

  it("says the counts and the choice, with the right plurals", () => {
    expect(eraseSummary(target)).toBe(
      "It will remove 3 messages, 1 note and 1 saved contact. It will not keep the sender blocked, and any existing block on this address goes too.",
    );
    expect(eraseSummary({ also_block: true, messages: 1, notes: 0, contacts: 0 })).toBe(
      "It will remove 1 message, 0 notes and 0 saved contacts. It will also keep the sender blocked.",
    );
  });

  it("adds the wait and how to cancel after asking", () => {
    const text = eraseRequested(target);
    expect(text).toContain("waits 24 hours");
    expect(text).toContain("cancel");
  });

  it("recognises only the shape the API stores", () => {
    expect(isEraseTarget(target)).toBe(true);
    for (const bad of [null, {}, { ...target, messages: "3" }, { ...target, also_block: 1 }, { ...target, notes: -1 }]) {
      expect(isEraseTarget(bad)).toBe(false);
    }
  });
});
