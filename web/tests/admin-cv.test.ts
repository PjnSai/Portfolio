import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "@/lib/admin/api";
import {
  CV_MAX_BYTES,
  type CvVersion,
  checkFile,
  countryText,
  cvApi,
  deleteBlocked,
  dayCountText,
  isFull,
  kindText,
  pendingSwitches,
  pendingVersionDeletion,
  sizeText,
  switchesLine,
  switchesPayload,
  uploadMessage,
  versionFileHref,
} from "@/lib/admin/cv";

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

const version = (over: Partial<CvVersion> = {}): CvVersion => ({
  id: "11111111-1111-4111-8111-111111111111",
  size: 120_000,
  sha256: "a".repeat(64),
  created_at: "2026-11-20T10:00:00+00:00",
  is_live: false,
  file: "/api/v1/admin/cv/versions/11111111-1111-4111-8111-111111111111/file",
  ...over,
});

describe("the calls", () => {
  it("reads versions, switches and logs from the admin routes", async () => {
    const { calls, fetcher } = fakeFetch([
      [200, { versions: [], max_versions: 10 }],
      [200, { view: true, request: true, instant_download: true, pending: [] }],
      [200, { results: [], page: 2, pages: 3, count: 60 }],
      [200, { days: [], total: 0 }],
    ]);
    const cv = cvApi(createClient(fetcher));
    await cv.versions();
    await cv.switches();
    await cv.views(2);
    await cv.days();
    expect(calls.map((c) => at(c.url).pathname + at(c.url).search)).toEqual([
      "/api/v1/admin/cv/versions",
      "/api/v1/admin/cv/switches",
      "/api/v1/admin/cv/views?page=2",
      "/api/v1/admin/cv/views/days",
    ]);
  });

  it("asks for page 1 without a page parameter", async () => {
    const { calls, fetcher } = fakeFetch([[200, { results: [], page: 1, pages: 1, count: 0 }]]);
    await cvApi(createClient(fetcher)).views(1);
    expect(at(calls[0].url).search).toBe("");
  });

  it("uploads the file as the form field `file` and nothing else", async () => {
    const { calls, fetcher } = fakeFetch([[201, version()]]);
    const file = new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" });
    await cvApi(createClient(fetcher)).upload(file);
    expect(calls[0].init.method).toBe("POST");
    const form = calls[0].init.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect((form.get("file") as File).name).toBe("cv.pdf");
    expect(at(calls[0].url).pathname).toBe("/api/v1/admin/cv/versions");
  });

  it("sets a version live", async () => {
    const { calls, fetcher } = fakeFetch([[200, version({ is_live: true })]]);
    await cvApi(createClient(fetcher)).setLive("abc");
    expect(at(calls[0].url).pathname).toBe("/api/v1/admin/cv/versions/abc/live");
    expect(calls[0].init.method).toBe("POST");
  });

  it("requests a switch change as the cv_switches vital action with exactly three booleans", async () => {
    const { calls, fetcher } = fakeFetch([[201, {}]]);
    await cvApi(createClient(fetcher)).requestSwitches({ view: false, request: true, instant_download: false });
    expect(at(calls[0].url).pathname).toBe("/api/v1/admin/vital-actions/request");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      kind: "cv_switches",
      payload: { view: false, request: true, instant_download: false },
    });
  });

  it("requests a version's deletion as a permanent_delete of entity cv_version", async () => {
    const { calls, fetcher } = fakeFetch([[201, {}]]);
    await cvApi(createClient(fetcher)).requestDelete("abc");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      kind: "permanent_delete",
      payload: { entity: "cv_version", id: "abc" },
    });
  });
});

describe("switches", () => {
  it("builds the payload with every switch, changing one", () => {
    const now = { view: true, request: true, instant_download: false };
    expect(switchesPayload(now, "view", false)).toEqual({ view: false, request: true, instant_download: false });
    expect(switchesPayload(now, "instant_download", true)).toEqual({
      view: true,
      request: true,
      instant_download: true,
    });
  });

  it("describes a set of switches in words", () => {
    expect(switchesLine({ view: true, request: false, instant_download: true })).toBe(
      "View: on. Request: off. Instant download: on.",
    );
  });

  const action = (target: Record<string, string | number | boolean>, kind = "cv_switches") => ({
    id: "a",
    kind,
    target,
    state: "waiting" as const,
    requested_at: "",
    execute_after: "",
    expires_at: "",
  });

  it("finds pending switch changes and ignores other actions and odd targets", () => {
    const good = action({ view: false, request: true, instant_download: true });
    const found = pendingSwitches([
      action({ id: "x", entity: "message" }, "permanent_delete"),
      action({ view: "no" } as never),
      good,
    ]);
    expect(found).toEqual([{ action: good, target: { view: false, request: true, instant_download: true } }]);
  });

  it("finds a pending deletion of one CV version only", () => {
    const mine = action({ entity: "cv_version", id: "v1" }, "permanent_delete");
    const list = [action({ entity: "message", id: "v1" }, "permanent_delete"), mine];
    expect(pendingVersionDeletion(list, "v1")).toBe(mine);
    expect(pendingVersionDeletion(list, "v2")).toBeUndefined();
  });
});

describe("versions", () => {
  it("says sizes in words", () => {
    expect(sizeText(512)).toBe("512 bytes");
    expect(sizeText(120_000)).toBe("117 KB");
    expect(sizeText(2_500_000)).toBe("2.4 MB");
  });

  it("is full at the maximum", () => {
    const full = Array.from({ length: 10 }, (_, i) => version({ id: String(i) }));
    expect(isFull(full, 10)).toBe(true);
    expect(isFull(full.slice(1), 10)).toBe(false);
  });

  it("will not ask to delete the live version, and says why", () => {
    expect(deleteBlocked(version({ is_live: true }))).toMatch(/live/);
    expect(deleteBlocked(version())).toBe("");
  });

  it("points the download at the API's file route for that version only", () => {
    const href = versionFileHref("11111111-1111-4111-8111-111111111111");
    expect(href).toMatch(/\/api\/v1\/admin\/cv\/versions\/11111111-1111-4111-8111-111111111111\/file$/);
    expect(versionFileHref("../x")).toBe("");
  });
});

describe("the file picker's hints", () => {
  const file = (name: string, size: number, type = "application/pdf") => ({ name, size, type });

  it("accepts a PDF under the limit", () => {
    expect(checkFile(file("cv.pdf", 1000))).toBe("");
    expect(checkFile(file("CV.PDF", 1000))).toBe("");
  });

  it.each([
    [file("cv.docx", 1000, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
    [file("cv.pdf", 1000, "image/png")],
    [file("cv.pdf", 0)],
    [file("cv.pdf", CV_MAX_BYTES + 1)],
  ])("refuses %j", (bad) => {
    expect(checkFile(bad)).not.toBe("");
  });

  it("lets a PDF with no declared type through to the API", () => {
    expect(checkFile(file("cv.pdf", 1000, ""))).toBe("");
  });
});

describe("upload errors", () => {
  it("shows the API's own message for a rejected file", () => {
    const error = new ApiError(400, { detail: "x", errors: { file: ["Choose a PDF file."] } });
    expect(uploadMessage(error)).toBe("Choose a PDF file.");
  });

  it("shows the API's message for a file that is too large, not the image wording", () => {
    const error = new ApiError(413, { detail: "x", errors: { file: ["Use a PDF under 5 MB."] } });
    expect(uploadMessage(error)).toBe("Use a PDF under 5 MB.");
  });

  it("shows the API's message when the versions are full", () => {
    const error = new ApiError(409, {
      detail: "Keep at most 10 versions. Delete one before uploading another.",
      code: "cv_versions_full",
    });
    expect(uploadMessage(error)).toBe("Keep at most 10 versions. Delete one before uploading another.");
  });

  it("falls back to the general wording for everything else", () => {
    expect(uploadMessage(new ApiError(429, {}))).toMatch(/Too many/);
    expect(uploadMessage(new ApiError(503, {}))).toMatch(/Try again/);
    expect(uploadMessage(new Error("x"))).toMatch(/Something went wrong/);
  });
});

describe("the view log", () => {
  it("names the kinds and the country in words", () => {
    expect(kindText("view")).toBe("Viewed");
    expect(kindText("download")).toBe("Downloaded");
    expect(countryText("GB")).toBe("GB");
    expect(countryText("")).toBe("Unknown");
  });

  it("says a day's count", () => {
    expect(dayCountText({ day: "2026-11-20", count: 1 })).toBe("1 visit");
    expect(dayCountText({ day: "2026-11-20", count: 4 })).toBe("4 visits");
  });
});
