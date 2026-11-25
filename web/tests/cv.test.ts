import { describe, expect, it, vi } from "vitest";
import {
  CV_NOTE_MAX,
  cvShown,
  fetchFile,
  fetchStatus,
  linkFrom,
  parseStatus,
  requestFailureText,
  requestViewLink,
  sendCvRequest,
  updatedText,
  validateRequest,
  viewFailureText,
} from "@/lib/public/cv";

const ORIGIN = "http://localhost:8100";
const TOKEN = "abc123:1abcDE:SIG-nature_9";
const PATH = `/api/v1/cv/file/${TOKEN}`;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function fetcherOf(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? json(500, {});
  });
  return { calls, fetcher };
}

describe("the CV status", () => {
  it("reads the three flags and the date", () => {
    expect(
      parseStatus({ can_view: true, can_request: true, instant_download: true, updated: "2026-11-20" }),
    ).toEqual({ canView: true, canRequest: true, instantDownload: true, updated: "2026-11-20" });
  });

  it("treats a missing instant_download as off", () => {
    expect(parseStatus({ can_view: true, can_request: false, updated: null })).toEqual({
      canView: true,
      canRequest: false,
      instantDownload: false,
      updated: null,
    });
  });

  it("only a literal true counts as instant download", () => {
    const status = (instant_download: unknown) =>
      parseStatus({ can_view: false, can_request: true, instant_download, updated: null });
    expect(status("yes")?.instantDownload).toBe(false);
    expect(status(1)?.instantDownload).toBe(false);
    expect(status(true)?.instantDownload).toBe(true);
  });

  it.each([null, "x", [], {}, { can_view: "yes", can_request: true }, { can_view: true }])(
    "refuses a shape it does not know: %j",
    (body) => {
      expect(parseStatus(body)).toBeNull();
    },
  );

  it("ignores a date that is not a date", () => {
    expect(parseStatus({ can_view: true, can_request: false, updated: "<b>x</b>" })?.updated).toBeNull();
  });

  it("shows nothing about a CV unless a button or the form would show", () => {
    const base = { canView: false, canRequest: false, instantDownload: false, updated: null };
    expect(cvShown(base)).toBe(false);
    expect(cvShown({ ...base, instantDownload: true })).toBe(false);
    expect(cvShown({ ...base, canView: true })).toBe(true);
    expect(cvShown({ ...base, canRequest: true })).toBe(true);
    expect(cvShown(null)).toBe(false);
  });

  it("is fetched without cookies or referrer, and any failure is null", async () => {
    const ok = fetcherOf(json(200, { can_view: true, can_request: true, updated: null }));
    expect((await fetchStatus(ok.fetcher, ORIGIN))?.canView).toBe(true);
    expect(ok.calls[0].url).toBe(`${ORIGIN}/api/v1/cv`);
    expect(ok.calls[0].init.credentials).toBe("omit");
    expect(ok.calls[0].init.referrerPolicy).toBe("no-referrer");
    expect(await fetchStatus(fetcherOf(json(503, {})).fetcher, ORIGIN)).toBeNull();
    expect(await fetchStatus(fetcherOf(new Error("offline")).fetcher, ORIGIN)).toBeNull();
    expect(await fetchStatus(fetcherOf(new Response("<html>", { status: 200 })).fetcher, ORIGIN)).toBeNull();
  });
});

describe("a signed link", () => {
  it("is made absolute only from the documented shape", () => {
    expect(linkFrom({ url: PATH, expires_in: 60 }, ORIGIN)).toBe(`${ORIGIN}${PATH}`);
  });

  it.each([
    [{}],
    [{ url: PATH }],
    [{ url: PATH, expires_in: 61 }],
    [{ url: PATH, expires_in: "60" }],
    [{ url: "https://evil.example/x", expires_in: 60 }],
    [{ url: "//evil.example/api/v1/cv/file/a", expires_in: 60 }],
    [{ url: "/api/v1/cv/file/../admin", expires_in: 60 }],
    [{ url: "/api/v1/cv/file/a?x=1", expires_in: 60 }],
    [{ url: "/api/v1/admin/session", expires_in: 60 }],
    [{ url: "javascript:alert(1)", expires_in: 60 }],
    [null],
  ])("refuses %j", (body) => {
    expect(linkFrom(body, ORIGIN)).toBeNull();
  });
});

describe("asking for a view link", () => {
  it("posts only the token, with no credentials, and returns the link", async () => {
    const { calls, fetcher } = fetcherOf(json(200, { url: PATH, expires_in: 60 }));
    expect(await requestViewLink(fetcher, ORIGIN, "tok")).toEqual({ kind: "link", url: `${ORIGIN}${PATH}` });
    expect(calls[0].url).toBe(`${ORIGIN}/api/v1/cv/link`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ turnstile: "tok" });
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.referrerPolicy).toBe("no-referrer");
  });

  it.each([
    [400, { code: "challenge" }, "check"],
    [403, { detail: "Forbidden." }, "forbidden"],
    [503, {}, "unavailable"],
    [500, {}, "failed"],
    [200, { nope: 1 }, "failed"],
  ])("maps %i to %s", async (status, body, kind) => {
    const outcome = await requestViewLink(fetcherOf(json(status, body)).fetcher, ORIGIN, "t");
    expect(outcome.kind).toBe(kind);
  });

  it("reads Retry-After on 429", async () => {
    const outcome = await requestViewLink(
      fetcherOf(json(429, {}, { "Retry-After": "120" })).fetcher,
      ORIGIN,
      "t",
    );
    expect(outcome).toEqual({ kind: "limited", seconds: 120 });
  });

  it("fails on a network error", async () => {
    expect((await requestViewLink(fetcherOf(new Error("x")).fetcher, ORIGIN, "t")).kind).toBe("failed");
  });
});

describe("fetching the file", () => {
  const pdf = () => new Response(new TextEncoder().encode("%PDF-1.4\n%%EOF"), { status: 200 });

  it("returns the bytes, fetched without cookies, referrer or cache", async () => {
    const { calls, fetcher } = fetcherOf(pdf());
    const outcome = await fetchFile(fetcher, `${ORIGIN}${PATH}`);
    expect(outcome.kind).toBe("pdf");
    if (outcome.kind === "pdf") expect(new TextDecoder().decode(outcome.bytes).startsWith("%PDF-")).toBe(true);
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.referrerPolicy).toBe("no-referrer");
    expect(calls[0].init.cache).toBe("no-store");
  });

  it("treats 404 as an expired link, 403 as off, 429 as limited, 503 as unavailable", async () => {
    expect((await fetchFile(fetcherOf(json(404, {})).fetcher, `${ORIGIN}${PATH}`)).kind).toBe("expired");
    expect((await fetchFile(fetcherOf(json(403, {})).fetcher, `${ORIGIN}${PATH}`)).kind).toBe("forbidden");
    expect(
      await fetchFile(fetcherOf(json(429, {}, { "Retry-After": "30" })).fetcher, `${ORIGIN}${PATH}`),
    ).toEqual({ kind: "limited", seconds: 30 });
    expect((await fetchFile(fetcherOf(json(503, {})).fetcher, `${ORIGIN}${PATH}`)).kind).toBe("unavailable");
  });

  it("refuses an answer that is not a PDF", async () => {
    const html = new Response("<html></html>", { status: 200 });
    expect((await fetchFile(fetcherOf(html).fetcher, `${ORIGIN}${PATH}`)).kind).toBe("failed");
  });

  it("fails on a network error", async () => {
    expect((await fetchFile(fetcherOf(new Error("x")).fetcher, `${ORIGIN}${PATH}`)).kind).toBe("failed");
  });
});

describe("the request form's checks", () => {
  const GOOD = { name: "", email: "sam@example.com", note: "" };

  it("needs only an email", () => {
    expect(validateRequest(GOOD)).toEqual({});
    expect(validateRequest({ ...GOOD, name: "Sam", note: "Hello" })).toEqual({});
  });

  it.each([
    [{ email: "" }, "email"],
    [{ email: "nope" }, "email"],
    [{ email: "a b@example.com" }, "email"],
    [{ name: "x".repeat(101) }, "name"],
    [{ note: "x".repeat(CV_NOTE_MAX + 1) }, "note"],
  ] as const)("refuses %j in %s", (change, field) => {
    expect(Object.keys(validateRequest({ ...GOOD, ...change }))).toEqual([field]);
  });

  it("counts the note after hidden characters are removed", () => {
    const hidden = String.fromCharCode(0x200b);
    expect(validateRequest({ ...GOOD, note: `${hidden}${"x".repeat(CV_NOTE_MAX)}` })).toEqual({});
  });
});

describe("sending the request", () => {
  const PAYLOAD = { name: "", email: "sam@example.com", note: "", website: "", elapsed: 5000, turnstile: "tok" };

  it("posts the form with no credentials to /cv/request", async () => {
    const { calls, fetcher } = fetcherOf(json(201, { detail: "Received." }));
    await sendCvRequest(fetcher, ORIGIN, PAYLOAD);
    expect(calls[0].url).toBe(`${ORIGIN}/api/v1/cv/request`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(PAYLOAD);
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.referrerPolicy).toBe("no-referrer");
  });

  it("is sent without a link when the answer has none", async () => {
    expect(await sendCvRequest(fetcherOf(json(201, {})).fetcher, ORIGIN, PAYLOAD)).toEqual({
      kind: "sent",
      download: null,
    });
  });

  it("carries the link only when it has the documented shape", async () => {
    const withLink = fetcherOf(json(201, { url: PATH, expires_in: 60 }));
    expect(await sendCvRequest(withLink.fetcher, ORIGIN, PAYLOAD)).toEqual({
      kind: "sent",
      download: `${ORIGIN}${PATH}`,
    });
    const odd = fetcherOf(json(201, { url: "https://evil.example/", expires_in: 60 }));
    expect(await sendCvRequest(odd.fetcher, ORIGIN, PAYLOAD)).toEqual({ kind: "sent", download: null });
  });

  it("answers 200 and 201 the same way", async () => {
    expect((await sendCvRequest(fetcherOf(json(200, {})).fetcher, ORIGIN, PAYLOAD)).kind).toBe("sent");
  });

  it("reads field errors for the form's own fields only", async () => {
    const body = {
      errors: { email: ["Enter a valid email address."], other: ["x"], note: ["Use 500 characters or fewer."] },
    };
    const outcome = await sendCvRequest(fetcherOf(json(400, body)).fetcher, ORIGIN, PAYLOAD);
    expect(outcome).toEqual({
      kind: "fields",
      errors: { email: "Enter a valid email address.", note: "Use 500 characters or fewer." },
    });
  });

  it.each([
    [400, { code: "challenge" }, "check"],
    [400, { detail: "x" }, "failed"],
    [403, {}, "forbidden"],
    [503, {}, "unavailable"],
    [500, {}, "failed"],
  ])("maps %i %j to %s", async (status, body, kind) => {
    expect((await sendCvRequest(fetcherOf(json(status, body)).fetcher, ORIGIN, PAYLOAD)).kind).toBe(kind);
  });

  it("maps 429 with its wait", async () => {
    const outcome = await sendCvRequest(fetcherOf(json(429, {}, { "Retry-After": "600" })).fetcher, ORIGIN, PAYLOAD);
    expect(outcome).toEqual({ kind: "limited", seconds: 600 });
  });

  it("fails on a network error", async () => {
    expect((await sendCvRequest(fetcherOf(new Error("x")).fetcher, ORIGIN, PAYLOAD)).kind).toBe("failed");
  });
});

describe("the date", () => {
  it("is said as a sentence, or not at all", () => {
    expect(updatedText("2026-11-05")).toBe("Updated 5 November 2026.");
    expect(updatedText(null)).toBe("");
    expect(updatedText("2026-13-05")).toBe("");
    expect(updatedText("junk")).toBe("");
  });
});

describe("words for failures", () => {
  it("has a sentence for every failure", () => {
    for (const kind of ["check", "forbidden", "unavailable", "failed", "expired"] as const) {
      expect(viewFailureText({ kind }).length).toBeGreaterThan(10);
    }
    expect(viewFailureText({ kind: "limited", seconds: 90 })).toContain("2 minutes");
    expect(requestFailureText({ kind: "forbidden" })).toMatch(/not available/i);
    expect(requestFailureText({ kind: "limited", seconds: 3600 })).toContain("an hour");
  });

  it("does not say whether a sender was blocked or held back", () => {
    for (const kind of ["check", "forbidden", "unavailable", "failed"] as const) {
      expect(requestFailureText({ kind })).not.toMatch(/block|held back|quarantin/i);
    }
    expect(requestFailureText({ kind: "limited", seconds: 60 })).not.toMatch(/block|held back|quarantin/i);
  });
});
