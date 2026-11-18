import { describe, expect, it, vi } from "vitest";
import { apiOrigin } from "@/lib/api-base";
import { EMPTY_SITE, loadSite, srcset } from "@/lib/site";

const SITE = {
  settings: { title: "Pujan Shahi" },
  sections: [{ title: "Projects" }],
  media: {},
};

describe("apiOrigin", () => {
  it.each([
    ["https://api.portfolio.test", "https://api.portfolio.test"],
    ["https://api.portfolio.test/", "https://api.portfolio.test"],
    ["http://localhost:8100", "http://localhost:8100"],
    [undefined, ""],
    ["", ""],
  ])("%s gives %s", (raw, origin) => {
    expect(apiOrigin(raw)).toBe(origin);
  });

  it.each([
    "http://api.portfolio.test",
    "https://api.portfolio.test/api/v1",
    "https://user:pass@api.portfolio.test",
    "https://api.portfolio.test?x=1",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(() => apiOrigin(raw)).toThrow();
  });
});

describe("loadSite", () => {
  it("reads the published site from the API", async () => {
    const fetcher = vi.fn(async () => Response.json(SITE));

    const site = await loadSite({ API_BASE_URL: "https://api.portfolio.test" }, fetcher);

    expect(site).toEqual(SITE);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.portfolio.test/api/v1/site",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("builds without content when no API is set", async () => {
    const fetcher = vi.fn();

    expect(await loadSite({}, fetcher)).toEqual(EMPTY_SITE);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("can be told to skip the read, for a container image built before its API runs", async () => {
    const fetcher = vi.fn();
    const env = { API_BASE_URL: "https://api.portfolio.test", SKIP_SITE_FETCH: "1" };

    expect(await loadSite(env, fetcher)).toEqual(EMPTY_SITE);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ CF_PAGES: "1" }, { CF_PAGES: "1", API_BASE_URL: "https://a.test", SKIP_SITE_FETCH: "1" }])(
    "fails a Pages build that would have no content",
    async (env) => {
      await expect(loadSite(env, vi.fn())).rejects.toThrow(/API_BASE_URL/);
    },
  );

  it.each([
    ["an error status", async () => new Response("down", { status: 503 })],
    ["something else", async () => Response.json({ detail: "x" })],
    ["no published sections", async () => Response.json({ settings: {}, sections: [], media: {} })],
    ["a redirect it may not follow", async () => new Response(null, { status: 302 })],
    ["no answer", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("fails the build on %s, so the last good build stays live", async (_, fetcher) => {
    await expect(
      loadSite({ API_BASE_URL: "https://api.portfolio.test" }, fetcher as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("srcset", () => {
  it("lists each width with the API origin in front", () => {
    const item = {
      width: 1600,
      height: 800,
      sources: [
        { width: 480, height: 240, url: "/api/v1/media/a-480.webp" },
        { width: 960, height: 480, url: "/api/v1/media/a-960.webp" },
      ],
    };

    expect(srcset(item, "https://api.portfolio.test")).toBe(
      "https://api.portfolio.test/api/v1/media/a-480.webp 480w, " +
        "https://api.portfolio.test/api/v1/media/a-960.webp 960w",
    );
  });
});
