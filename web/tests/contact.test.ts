import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChecker,
  elapsedMs,
  LIMITS,
  loadTurnstile,
  type Outcome,
  outcomeText,
  type Payload,
  problems,
  resetTurnstileLoader,
  send,
  summary,
  TOKEN_TIMEOUT_MS,
  tidy,
  TURNSTILE_SRC,
  type TurnstileApi,
  validate,
  type Values,
  waitText,
  warmUp,
} from "@/lib/public/contact";
import { armLazyLoad, NEAR_VIEWPORT } from "@/lib/public/lazy";
import { DUMMY_INVISIBLE_KEY, siteKeyFrom } from "@/lib/public/turnstile-key";

const GOOD: Values = {
  name: "Sam Recruiter",
  email: "sam@example.com",
  reason: "hiring",
  body: "Hello, I would like to talk about a role.",
};

describe("checks before sending", () => {
  it("accepts a good message", () => {
    expect(validate(GOOD)).toEqual({});
    expect(validate({ ...GOOD, reason: "" })).toEqual({});
  });

  it.each([
    [{ name: "" }, "name"],
    [{ name: "   " }, "name"],
    [{ name: "x".repeat(LIMITS.name + 1) }, "name"],
    [{ email: "" }, "email"],
    [{ email: "not-an-email" }, "email"],
    [{ email: "a@b" }, "email"],
    [{ email: "a b@example.com" }, "email"],
    [{ email: "a@example.com,b@example.com" }, "email"],
    [{ email: "<a@example.com>" }, "email"],
    [{ email: "a@@example.com" }, "email"],
    [{ email: "@example.com" }, "email"],
    [{ email: "a@.example.com" }, "email"],
    [{ email: "a@example.com." }, "email"],
    [{ email: `${"x".repeat(250)}@example.com` }, "email"],
    [{ reason: "spam" }, "reason"],
    [{ reason: "Hiring" }, "reason"],
    [{ body: "short" }, "body"],
    [{ body: "x".repeat(LIMITS.bodyMax + 1) }, "body"],
  ] as const)("refuses %j in %s", (change, field) => {
    const errors = validate({ ...GOOD, ...change });
    expect(errors[field]).toBeTruthy();
    expect(problems(errors)).toEqual([field]);
  });

  it("allows the limits exactly", () => {
    expect(validate({ ...GOOD, name: "x".repeat(LIMITS.name) })).toEqual({});
    expect(validate({ ...GOOD, body: "y".repeat(LIMITS.bodyMax) })).toEqual({});
    expect(validate({ ...GOOD, body: "y".repeat(LIMITS.bodyMin) })).toEqual({});
  });

  it("counts a message after the hidden marks are taken out and the ends trimmed", () => {
    expect(validate({ ...GOOD, body: `${" ".repeat(20)}hi${String.fromCharCode(0)}`.padEnd(30, " ") })).toEqual({
      body: "Write a little more.",
    });
  });

  it("tidies text the way the API does: marks out, line ends one kind, ends trimmed", () => {
    const hidden = String.fromCharCode(0x200b, 0x202e, 0x7, 0x1b);
    const tidied = tidy({
      name: ` Sam${hidden} `,
      email: ` sam${hidden}@example.com `,
      reason: "hiring",
      body: `  first\r\nsecond\rthird${hidden}  `,
    });
    expect(tidied).toEqual({
      name: "Sam",
      email: "sam@example.com",
      reason: "hiring",
      body: "first\nsecond\nthird",
    });
  });

  it("lists problems in form order and says them in one sentence for a screen reader", () => {
    const errors = validate({ name: "", email: "x", reason: "", body: "" });
    expect(problems(errors)).toEqual(["name", "email", "body"]);
    expect(summary(errors)).toBe("The message was not sent. There are 3 problems: Name, Email and Message.");
    expect(summary({ email: "x" })).toBe("The message was not sent. There is a problem with Email.");
    expect(summary({})).toBe("");
  });
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const PAYLOAD: Payload = { ...tidy(GOOD), website: "", elapsed: 5000, turnstile: "token-1" };

describe("sending", () => {
  it("posts JSON to the contact route with no credentials and no referrer", async () => {
    const fetcher = vi.fn(reply(201, { detail: "ok" }));

    const outcome = await send(fetcher, "https://api.example.test", PAYLOAD);

    expect(outcome).toEqual({ kind: "sent" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/contact");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(Object.keys(new Headers(init.headers))).toEqual([]);
    expect(JSON.parse(String(init.body))).toEqual(PAYLOAD);
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(
      ["body", "elapsed", "email", "name", "reason", "turnstile", "website"].sort(),
    );
  });

  it.each([
    [201, { detail: "ok" }, { kind: "sent" }],
    [400, { code: "challenge", detail: "x" }, { kind: "check" }],
    [400, { errors: { email: ["Enter a valid email address."] } }, { kind: "fields", errors: { email: "Enter a valid email address." } }],
    [400, { errors: { body: ["Write a little more."], surprise: ["ignored"] } }, { kind: "fields", errors: { body: "Write a little more." } }],
    [400, { errors: { surprise: ["ignored"] } }, { kind: "failed" }],
    [400, { detail: "Bad request." }, { kind: "failed" }],
    [403, { detail: "Forbidden." }, { kind: "failed" }],
    [413, {}, { kind: "failed" }],
    [429, { code: "rate_limited" }, { kind: "limited", seconds: 3600 }],
    [500, {}, { kind: "failed" }],
    [503, { detail: "Service unavailable." }, { kind: "unavailable" }],
  ] as [number, unknown, Outcome][])("answers %i as %j", async (status, body, expected) => {
    expect(await send(reply(status, body), "https://api.example.test", PAYLOAD)).toEqual(expected);
  });

  it("reads how long to wait from Retry-After", async () => {
    const outcome = await send(reply(429, {}, { "Retry-After": "1800" }), "", PAYLOAD);
    expect(outcome).toEqual({ kind: "limited", seconds: 1800 });
    expect(await send(reply(429, {}, { "Retry-After": "soon" }), "", PAYLOAD)).toEqual({ kind: "limited", seconds: 3600 });
  });

  it("treats a network error or an answer that is not JSON as a failure", async () => {
    const down = async () => {
      throw new TypeError("network");
    };
    expect(await send(down, "", PAYLOAD)).toEqual({ kind: "failed" });
    const html = async () => new Response("<html>", { status: 502 });
    expect(await send(html, "", PAYLOAD)).toEqual({ kind: "failed" });
    const emptyOk = async () => new Response("", { status: 201 });
    expect(await send(emptyOk, "", PAYLOAD)).toEqual({ kind: "sent" });
  });
});

describe("what the visitor is told", () => {
  it("says how long to wait in plain words", () => {
    expect(waitText(30)).toBe("a minute");
    expect(waitText(60)).toBe("a minute");
    expect(waitText(61)).toBe("2 minutes");
    expect(waitText(1800)).toBe("30 minutes");
    expect(waitText(3600)).toBe("an hour");
    expect(waitText(7300)).toBe("3 hours");
  });

  it("has a sentence for each failure, and none says which other check failed", () => {
    const kinds: Outcome[] = [
      { kind: "check" },
      { kind: "limited", seconds: 1200 },
      { kind: "unavailable" },
      { kind: "failed" },
    ];
    for (const outcome of kinds) {
      const text = outcomeText(outcome);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/honeypot|too fast|quarantine|score|repeated|rushed/i);
      expect(text).not.toContain("@");
    }
    expect(outcomeText({ kind: "limited", seconds: 1200 })).toContain("20 minutes");
    expect(outcomeText({ kind: "sent" })).toBe("");
  });

  it("measures how long the form was open in whole milliseconds, never below zero", () => {
    expect(elapsedMs(1000, 6123.6)).toBe(5124);
    expect(elapsedMs(1000, 900)).toBe(0);
  });
});

type FakeScript = { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null };

function fakeDocument() {
  const added: FakeScript[] = [];
  const doc = {
    createElement: () => ({ src: "", async: false, onload: null, onerror: null }) as FakeScript,
    head: { append: (script: FakeScript) => added.push(script) },
  };
  return { doc: doc as unknown as Document, added };
}

describe("Turnstile's script", () => {
  beforeEach(() => resetTurnstileLoader());

  it("is added once, from Cloudflare's documented address, and waited for", async () => {
    const { doc, added } = fakeDocument();
    const api = {} as TurnstileApi;
    const win = {} as Window & { turnstile?: TurnstileApi };

    const first = loadTurnstile(doc, win);
    const second = loadTurnstile(doc, win);
    expect(added).toHaveLength(1);
    expect(added[0].src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(TURNSTILE_SRC).toBe(added[0].src);
    expect(added[0].async).toBe(true);

    win.turnstile = api;
    added[0].onload?.();
    expect(await first).toBe(api);
    expect(await second).toBe(api);
  });

  it("does not add the script again if Turnstile is already there", async () => {
    const { doc, added } = fakeDocument();
    const api = {} as TurnstileApi;

    expect(await loadTurnstile(doc, { turnstile: api } as unknown as Window)).toBe(api);
    expect(added).toHaveLength(0);
  });

  it("fails if the script cannot load, and tries again next time", async () => {
    const { doc, added } = fakeDocument();
    const win = {} as Window & { turnstile?: TurnstileApi };

    const failed = loadTurnstile(doc, win);
    added[0].onerror?.();
    await expect(failed).rejects.toThrow("did not load");

    const retry = loadTurnstile(doc, win);
    expect(added).toHaveLength(2);
    win.turnstile = {} as TurnstileApi;
    added[1].onload?.();
    await expect(retry).resolves.toBeTruthy();
  });

  it("fails if the script loaded but Turnstile is missing", async () => {
    const { doc, added } = fakeDocument();
    const loaded = loadTurnstile(doc, {} as Window);
    added[0].onload?.();
    await expect(loaded).rejects.toThrow("missing");
  });
});

function fakeApi() {
  const calls: string[] = [];
  let options: Record<string, unknown> = {};
  const api: TurnstileApi = {
    render: (_container, given) => {
      options = given;
      calls.push("render");
      return "widget-1";
    },
    execute: (id) => calls.push(`execute ${id}`),
    reset: (id) => calls.push(`reset ${id}`),
    remove: (id) => calls.push(`remove ${id}`),
  };
  return { api, calls, options: () => options };
}

describe("the invisible check", () => {
  afterEach(() => vi.useRealTimers());

  it("draws the widget once, set to run only when asked and to show only if a person is needed", () => {
    const { api, calls, options } = fakeApi();

    createChecker(api, {} as HTMLElement, "site-key");

    expect(calls).toEqual(["render"]);
    expect(options()).toMatchObject({ sitekey: "site-key", execution: "execute", appearance: "interaction-only" });
  });

  it("gives a token when Turnstile calls back, and resets the widget before each later use", async () => {
    const { api, calls, options } = fakeApi();
    const checker = createChecker(api, {} as HTMLElement, "k");
    const callback = () => options().callback as (token: string) => void;

    const one = checker.token();
    callback()("token-1");
    expect(await one).toBe("token-1");
    const two = checker.token();
    callback()("token-2");
    expect(await two).toBe("token-2");

    expect(calls).toEqual(["render", "execute widget-1", "reset widget-1", "execute widget-1"]);
  });

  it.each(["error-callback", "expired-callback", "timeout-callback"])("fails when Turnstile reports %s", async (name) => {
    const { api, options } = fakeApi();
    const checker = createChecker(api, {} as HTMLElement, "k");

    const pending = checker.token();
    (options()[name] as () => void)();

    await expect(pending).rejects.toThrow();
  });

  it("gives up if nothing comes back in time", async () => {
    vi.useFakeTimers();
    const { api } = fakeApi();
    const checker = createChecker(api, {} as HTMLElement, "k");

    const pending = checker.token();
    const failed = expect(pending).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS + 1);

    await failed;
  });

  it("is taken away when the form goes", () => {
    const { api, calls } = fakeApi();
    createChecker(api, {} as HTMLElement, "k").dispose();
    expect(calls).toContain("remove widget-1");
  });
});

class FakeObserver {
  static last: FakeObserver;
  disconnected = false;
  observed: Element[] = [];
  constructor(
    public callback: (entries: { isIntersecting: boolean }[]) => void,
    public options?: { rootMargin?: string },
  ) {
    FakeObserver.last = this;
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function fakeRoot(focused = false) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    matches: (selector: string) => selector === ":focus-within" && focused,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

describe("when the form's code is fetched", () => {
  it("watches for the form to come within a screen of the visible page", () => {
    const root = fakeRoot();
    armLazyLoad(root as unknown as HTMLElement, () => undefined, FakeObserver);

    expect(FakeObserver.last.options).toEqual({ rootMargin: NEAR_VIEWPORT });
    expect(NEAR_VIEWPORT).toBe("400px 0px");
    expect(FakeObserver.last.observed).toHaveLength(1);
  });

  it("does not fetch anything while the form is far away", () => {
    const load = vi.fn();
    armLazyLoad(fakeRoot() as unknown as HTMLElement, load, FakeObserver);

    FakeObserver.last.callback([{ isIntersecting: false }]);

    expect(load).not.toHaveBeenCalled();
  });

  it("fetches once when the form comes near, and stops watching", () => {
    const load = vi.fn();
    const root = fakeRoot();
    armLazyLoad(root as unknown as HTMLElement, load, FakeObserver);

    FakeObserver.last.callback([{ isIntersecting: true }]);
    FakeObserver.last.callback([{ isIntersecting: true }]);
    root.fire("focusin");

    expect(load).toHaveBeenCalledTimes(1);
    expect(FakeObserver.last.disconnected).toBe(true);
    expect(root.count("focusin")).toBe(0);
  });

  it("fetches at once when something in the form had focus before it started watching", () => {
    const load = vi.fn();
    const root = fakeRoot(true);
    armLazyLoad(root as unknown as HTMLElement, load, FakeObserver);

    expect(load).toHaveBeenCalledTimes(1);
    expect(FakeObserver.last.disconnected).toBe(true);
    expect(root.count("focusin")).toBe(0);
  });

  it("fetches at once when something in the form takes focus, far away or not", () => {
    const load = vi.fn();
    const root = fakeRoot();
    armLazyLoad(root as unknown as HTMLElement, load, FakeObserver);

    root.fire("focusin");
    root.fire("focusin");
    FakeObserver.last.callback([{ isIntersecting: true }]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(FakeObserver.last.disconnected).toBe(true);
  });

  it("falls back to focus alone when there is no IntersectionObserver", () => {
    const load = vi.fn();
    const root = fakeRoot();
    armLazyLoad(root as unknown as HTMLElement, load);

    expect(load).not.toHaveBeenCalled();
    root.fire("focusin");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fetches nothing once stopped", () => {
    const load = vi.fn();
    const root = fakeRoot();
    const stop = armLazyLoad(root as unknown as HTMLElement, load, FakeObserver);

    stop();
    root.fire("focusin");
    FakeObserver.last.callback([{ isIntersecting: true }]);

    expect(load).not.toHaveBeenCalled();
    expect(FakeObserver.last.disconnected).toBe(true);
  });
});

describe("the warm-up request", () => {
  it("sends one plain GET to the CV status, with nothing about the visitor", () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    warmUp(fetcher, "https://api.example.test");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://api.example.test/api/v1/cv", {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  });

  it("sends nothing with no API, and never throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    warmUp(fetcher, "");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => warmUp(fetcher, "https://api.example.test")).not.toThrow();
    await Promise.resolve();
  });
});

describe("the site key", () => {
  it("uses Cloudflare's dummy invisible key for a local build with none", () => {
    expect(siteKeyFrom({})).toBe(DUMMY_INVISIBLE_KEY);
    expect(DUMMY_INVISIBLE_KEY).toBe("1x00000000000000000000BB");
  });

  it("has no key on Cloudflare Pages unless one is given, so no form is shown", () => {
    expect(siteKeyFrom({ CF_PAGES: "1" })).toBe("");
    expect(siteKeyFrom({ CF_PAGES: "1", TURNSTILE_SITE_KEY: "0x4AAAAAAAabcdefghijkl" })).toBe(
      "0x4AAAAAAAabcdefghijkl",
    );
  });

  it("refuses something that is not a site key", () => {
    for (const bad of ["short", "has space in it 1234567", "<script>alert(1)</script>", "x".repeat(65)]) {
      expect(() => siteKeyFrom({ TURNSTILE_SITE_KEY: bad })).toThrow("not a Turnstile site key");
    }
  });
});
