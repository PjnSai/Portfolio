import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, describeError } from "@/lib/admin/api";
import {
  checkContact,
  contactFiltersFrom,
  contactHref,
  contactPageFrom,
  contactsApi,
  contactsHref,
  formFrom,
  hasContactFilters,
  messageHref,
  NO_CONTACT_FILTERS,
  parseTags,
} from "@/lib/admin/contacts";

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
const MESSAGE = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function setup(...answers: Array<[number, unknown]>) {
  const { calls, fetcher } = fakeFetch(answers);
  return { calls, contacts: contactsApi(createClient(fetcher)) };
}

describe("the contacts client", () => {
  it("lists with only the filters that are set", async () => {
    const { calls, contacts } = setup();
    await contacts.list(1).catch(() => undefined);
    await contacts.list(3, { q: " sam ", tag: "recruiter", due: true }).catch(() => undefined);
    const urls = calls.map((c) => c.url).filter((u) => u.includes("/contacts"));
    expect(urls[0]).toMatch(/\/admin\/contacts$/);
    const second = at(urls[1]);
    expect(Object.fromEntries(second.searchParams)).toEqual({
      q: "sam",
      tag: "recruiter",
      due: "1",
      page: "3",
    });
  });

  it("opens one contact by its id", async () => {
    const { calls, contacts } = setup([200, { id: ID }]);
    await contacts.open(ID);
    expect(calls[0].url).toMatch(new RegExp(`/admin/contacts/${ID}$`));
    expect(calls[0].init.method).toBe("GET");
  });

  it("creates from a message, sending only the fields given", async () => {
    const { calls, contacts } = setup([201, { id: ID }]);
    await contacts.createFromMessage(MESSAGE, { organisation: "Halverton", tags: ["a"] });
    expect(calls[0].url).toMatch(/\/admin\/contacts$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      message: MESSAGE,
      organisation: "Halverton",
      tags: ["a"],
    });
  });

  it("edits with PATCH, links and unlinks with the message id, deletes with POST", async () => {
    const { calls, contacts } = setup(
      [200, {}],
      [200, {}],
      [200, {}],
      [200, { deleted: true }],
    );
    await contacts.edit(ID, { follow_up: null });
    await contacts.link(ID, MESSAGE);
    await contacts.unlink(ID, MESSAGE);
    await contacts.remove(ID);
    const sent = calls.map((c) => [c.init.method, at(c.url).pathname, c.init.body]);
    expect(sent).toEqual([
      ["PATCH", `/api/v1/admin/contacts/${ID}`, JSON.stringify({ follow_up: null })],
      ["POST", `/api/v1/admin/contacts/${ID}/link`, JSON.stringify({ message: MESSAGE })],
      ["POST", `/api/v1/admin/contacts/${ID}/unlink`, JSON.stringify({ message: MESSAGE })],
      ["POST", `/api/v1/admin/contacts/${ID}/delete`, JSON.stringify({})],
    ]);
  });
});

describe("the API's contact refusals, in plain words", () => {
  it("says a contact exists", () => {
    const text = describeError(new ApiError(409, { code: "contact_exists" }));
    expect(text).toBe("There is already a saved contact for this email address.");
  });

  it("says the sender is different", () => {
    const text = describeError(new ApiError(409, { code: "different_sender" }));
    expect(text).toContain("different email address");
    expect(text).not.toMatch(/different_sender/);
  });

  it("keeps the general answer for a 409 without a known code", () => {
    expect(describeError(new ApiError(409, { code: "something_new" }))).toBe(
      "That is not possible right now.",
    );
  });
});

describe("contact form checks", () => {
  const empty = formFrom(null);

  it("accepts an empty form and sends no follow-up", () => {
    const { errors, fields } = checkContact(empty);
    expect(errors).toEqual({});
    expect(fields).toEqual({ organisation: "", tags: [], notes: "", follow_up: null });
  });

  it("parses tags: trimmed, no blanks, each once", () => {
    expect(parseTags(" a, b ,,a, c ")).toEqual(["a", "b", "c"]);
  });

  it("refuses too many tags, a long tag, long notes and a bad date", () => {
    const tags = Array.from({ length: 11 }, (_, n) => `t${n}`).join(",");
    expect(checkContact({ ...empty, tags }).errors.tags).toMatch(/at most 10/);
    expect(checkContact({ ...empty, tags: "x".repeat(31) }).errors.tags).toMatch(/30 characters/);
    expect(checkContact({ ...empty, notes: "x".repeat(5001) }).errors.notes).toMatch(/5000/);
    expect(checkContact({ ...empty, followUp: "2026-02-31" }).errors.followUp).toBeTruthy();
    expect(checkContact({ ...empty, followUp: "1999-12-31" }).errors.followUp).toBeTruthy();
    expect(checkContact({ ...empty, followUp: "2100-01-01" }).errors.followUp).toBeTruthy();
    expect(checkContact({ ...empty, followUp: "next week" }).errors.followUp).toBeTruthy();
  });

  it("accepts every field at its limit", () => {
    const { errors } = checkContact({
      organisation: "o".repeat(100),
      tags: Array.from({ length: 10 }, (_, n) => `${n}`.padEnd(30, "x")).join(","),
      notes: "n".repeat(5000),
      followUp: "2099-12-31",
    });
    expect(errors).toEqual({});
  });

  it("allows line breaks in notes but not other control characters", () => {
    expect(checkContact({ ...empty, notes: "one\r\ntwo\tthree" }).errors.notes).toBeUndefined();
    expect(checkContact({ ...empty, notes: "bad\u0007" }).errors.notes).toBeTruthy();
  });
});

describe("contact links", () => {
  const filters = { q: "sam", tag: "recruiter", due: true };

  it("builds the list and detail addresses, keeping the filters and page", () => {
    expect(contactsHref("/desk/contacts")).toBe("/desk/contacts");
    expect(contactsHref("/desk/contacts", 2, filters)).toBe(
      "/desk/contacts?q=sam&tag=recruiter&due=1&page=2",
    );
    expect(contactHref("/desk/contacts", ID, 2, filters)).toBe(
      `/desk/contacts?id=${ID}&q=sam&tag=recruiter&due=1&page=2`,
    );
    expect(messageHref("/desk/messages", MESSAGE)).toBe(`/desk/messages?id=${MESSAGE}`);
  });

  it("reads the filters from an address and drops what is not valid", () => {
    const get = (name: string) => ({ q: "x".repeat(300), tag: "t", due: "yes" })[name as "q"] ?? null;
    const read = contactFiltersFrom(get);
    expect(read.q).toHaveLength(100);
    expect(read.due).toBe(false);
    expect(hasContactFilters(NO_CONTACT_FILTERS)).toBe(false);
    expect(hasContactFilters(read)).toBe(true);
  });

  it("reads the page number safely", () => {
    expect(contactPageFrom("3")).toBe(3);
    for (const bad of [null, "0", "-1", "abc", "1e3", "9999999"]) {
      expect(contactPageFrom(bad)).toBe(1);
    }
  });
});
