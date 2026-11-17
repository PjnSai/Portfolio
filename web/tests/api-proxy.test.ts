import { describe, expect, it } from "vitest";
import {
  forwardedHeaders,
  returnedHeaders,
  upstreamUrl,
} from "@/lib/api-proxy";

describe("API proxy", () => {
  it("keeps the path inside /api/v1 on the API", () => {
    expect(
      upstreamUrl("http://api:8000", ["admin", "sections"], "?page=2"),
    ).toBe("http://api:8000/api/v1/admin/sections?page=2");
    for (const segments of [["..", "healthz"], ["admin", "."], ["", "x"]]) {
      expect(upstreamUrl("http://api:8000", segments, "")).toBeNull();
    }
    expect(upstreamUrl("http://api:8000", ["a/b", "c?d"], "")).toBe(
      "http://api:8000/api/v1/a%2Fb/c%3Fd",
    );
  });

  it("refuses an over-long path", () => {
    expect(upstreamUrl("http://api:8000", ["a".repeat(2000)], "")).toBeNull();
  });

  it("forwards only the headers the API needs", () => {
    const incoming = new Headers({
      Cookie: "__Host-session=abc",
      "Cf-Access-Jwt-Assertion": "jwt",
      "Cf-Connecting-Ip": "203.0.113.9",
      Origin: "https://site.test",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": "t",
      "Content-Type": "application/json",
      Host: "site.test",
      "X-Forwarded-Host": "evil.test",
      Authorization: "Bearer x",
    });

    const sent = forwardedHeaders(incoming);

    expect(Object.fromEntries(sent)).toEqual({
      cookie: "__Host-session=abc",
      "cf-access-jwt-assertion": "jwt",
      "cf-connecting-ip": "203.0.113.9",
      origin: "https://site.test",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "t",
      "content-type": "application/json",
    });
  });

  it("passes every cookie back and drops transport headers", () => {
    const upstream = new Headers();
    upstream.append("Set-Cookie", "a=1; Secure");
    upstream.append("Set-Cookie", "b=2; Secure");
    upstream.set("Content-Type", "application/json");
    upstream.set("Content-Encoding", "gzip");
    upstream.set("Content-Length", "10");
    upstream.set("Connection", "keep-alive");

    const back = returnedHeaders(upstream);

    expect(back.getSetCookie()).toEqual(["a=1; Secure", "b=2; Secure"]);
    expect(back.get("content-type")).toBe("application/json");
    expect(back.has("content-encoding")).toBe(false);
    expect(back.has("content-length")).toBe(false);
    expect(back.has("connection")).toBe(false);
  });
});
