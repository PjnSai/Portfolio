import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, describeError } from "@/lib/admin/api";

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls, fetcher };
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

describe("admin API client", () => {
  it("fetches a CSRF token and sends it on every state-changing request", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, { csrf_token: "token-1" }],
      [201, { id: "s1" }],
      [200, {}],
    ]);
    const api = createClient(fetcher);

    await api.post("/sections", { type: "text", title: "A" });
    await api.patch("/sections/s1", { title: "B" });

    expect(calls[0].url).toBe("/api/v1/admin/csrf");
    expect(header(calls[1], "X-CSRF-Token")).toBe("token-1");
    expect(header(calls[2], "X-CSRF-Token")).toBe("token-1");
    expect(calls[1].init.method).toBe("POST");
    expect(calls[2].init.method).toBe("PATCH");
    expect(calls[1].init.credentials).toBe("same-origin");
  });

  it("sends no CSRF token on reads", async () => {
    const { calls, fetcher } = fakeFetch([[200, { results: [] }]]);
    const api = createClient(fetcher);

    await api.get("/sections", { page: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v1/admin/sections?page=2");
    expect(header(calls[0], "X-CSRF-Token")).toBeNull();
  });

  it("takes the new token a sign-in returns", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, { csrf_token: "before" }],
      [200, { csrf_token: "after" }],
      [200, {}],
    ]);
    const api = createClient(fetcher);

    await api.post("/login/verify", {});
    await api.post("/logout");

    expect(header(calls[2], "X-CSRF-Token")).toBe("after");
  });

  it("raises an error with the field messages from the API", async () => {
    const { fetcher } = fakeFetch([
      [200, { csrf_token: "t" }],
      [
        400,
        { detail: "Some fields need changing.", errors: { title: ["Too long."] } },
      ],
    ]);
    const api = createClient(fetcher);

    const error = await api.post("/sections", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).fields).toEqual({ title: ["Too long."] });
  });

  it("asks for a passkey and retries once when confirmation is needed", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, { csrf_token: "t" }],
      [403, { detail: "Confirm with your passkey.", code: "elevation_required" }],
      [200, { done: true }],
    ]);
    const api = createClient(fetcher);
    const confirm = vi.fn(async () => {});

    const result = await api.withPasskey(
      () => api.post("/sessions/revoke-all"),
      confirm,
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(result).toEqual({ done: true });
    expect(calls.filter((c) => c.url.endsWith("revoke-all"))).toHaveLength(2);
  });

  it("does not ask for a passkey for other refusals", async () => {
    const { fetcher } = fakeFetch([
      [200, { csrf_token: "t" }],
      [409, { detail: "Not possible right now." }],
    ]);
    const api = createClient(fetcher);
    const confirm = vi.fn(async () => {});

    await expect(
      api.withPasskey(() => api.post("/x"), confirm),
    ).rejects.toBeInstanceOf(ApiError);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("only ever calls the admin API on this site", async () => {
    const { fetcher } = fakeFetch([]);
    const api = createClient(fetcher);

    await expect(api.get("//evil.test/x")).rejects.toThrow();
    await expect(api.get("https://evil.test/x")).rejects.toThrow();
    await expect(api.get("/../healthz")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("error messages", () => {
  it.each([
    [401, "You are signed out. Sign in again."],
    [409, "That is not possible right now."],
    [429, "Too many attempts. Wait a few minutes and try again."],
    [503, "The site cannot reach its database. Try again shortly."],
  ])("explains a %i in plain words", (status, text) => {
    expect(describeError(new ApiError(status, {}))).toBe(text);
  });

  it("explains a network failure", () => {
    expect(describeError(new TypeError("fetch failed"))).toBe(
      "Something went wrong. Try again.",
    );
  });
});
