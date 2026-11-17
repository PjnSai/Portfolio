import { describe, expect, it, vi } from "vitest";
import { createClient, describeError, ApiError } from "@/lib/admin/api";
import { checkUpload, MAX_UPLOAD_BYTES, mediaAltSchema } from "@/lib/admin/media";
import { bodyLimit, MAX_BODY_BYTES } from "@/lib/api-proxy";

describe("media uploads", () => {
  it("sends the form as multipart with the CSRF token and no JSON type", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return Response.json(calls.length === 1 ? { csrf_token: "t" } : { id: "m1" }, {
        status: calls.length === 1 ? 200 : 201,
      });
    });
    const api = createClient(fetcher);
    const form = new FormData();
    form.set("alt", "A desk");

    await api.upload("/media", form);

    const sent = calls[1];
    expect(sent.url).toBe("/api/v1/admin/media");
    expect(sent.init.body).toBe(form);
    const headers = new Headers(sent.init.headers);
    expect(headers.get("X-CSRF-Token")).toBe("t");
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("explains an oversize file", () => {
    expect(describeError(new ApiError(413, {}))).toMatch(/8 MB/);
  });

  it("requires alt text on one line", () => {
    expect(mediaAltSchema.safeParse({ alt: "" }).success).toBe(false);
    expect(mediaAltSchema.safeParse({ alt: "   " }).success).toBe(false);
    expect(mediaAltSchema.safeParse({ alt: "a\nb" }).success).toBe(false);
    expect(mediaAltSchema.safeParse({ alt: "a".repeat(301) }).success).toBe(false);
    expect(mediaAltSchema.safeParse({ alt: "A desk" }).success).toBe(true);
  });

  it("checks size and type before sending, though the API decides", () => {
    const file = (size: number, type: string) =>
      new File([new Uint8Array(size)], "x", { type });
    expect(checkUpload(file(10, "image/jpeg"))).toBeNull();
    expect(checkUpload(file(10, "image/svg+xml"))).toMatch(/JPEG, PNG or WebP/);
    expect(checkUpload(file(MAX_UPLOAD_BYTES + 1, "image/png"))).toMatch(/8 MB/);
  });
});

describe("proxy body limit", () => {
  it("is larger only for uploads to the media library", () => {
    expect(bodyLimit("POST", ["admin", "media"])).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(bodyLimit("POST", ["admin", "sections"])).toBe(MAX_BODY_BYTES);
    expect(bodyLimit("PATCH", ["admin", "media"])).toBe(MAX_BODY_BYTES);
    expect(bodyLimit("POST", ["admin", "media", "x"])).toBe(MAX_BODY_BYTES);
    expect(bodyLimit("POST", ["media"])).toBe(MAX_BODY_BYTES);
  });
});
