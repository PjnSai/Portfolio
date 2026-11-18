import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  EXTRA_SCRIPT_HASHES,
  isPrivatePath,
  STATIC_HEADERS,
} from "@/lib/security-headers";

const API = "https://api.portfolio.test";
const HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    }),
  );
}

const publicPolicy = contentSecurityPolicy({ scripts: [HASH], styles: [], api: API, admin: false });
const adminPolicy = contentSecurityPolicy({ scripts: [], styles: [HASH], api: API, admin: true });

describe("Content-Security-Policy", () => {
  it("lets scripts and styles run only from the site or by hash, with no nonce", () => {
    const policy = directives(publicPolicy);
    expect(policy.get("script-src")).toEqual(["'self'", `'${HASH}'`]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    expect(directives(adminPolicy).get("style-src")).toEqual(["'self'", `'${HASH}'`]);
    expect(publicPolicy).not.toContain("nonce-");
  });

  it("has no unsafe sources and no wildcards", () => {
    for (const text of [publicPolicy, adminPolicy]) {
      expect(text).not.toContain("unsafe-inline");
      expect(text).not.toContain("unsafe-eval");
      expect(text).not.toContain("strict-dynamic");
      expect(text).not.toContain("*");
    }
  });

  it("denies by default and blocks framing, plugins and base tags", () => {
    const policy = directives(publicPolicy);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("lets only the admin pages call the API; every page may show its images", () => {
    expect(directives(publicPolicy).get("connect-src")).toEqual(["'self'"]);
    expect(directives(adminPolicy).get("connect-src")).toEqual(["'self'", API]);
    expect(directives(publicPolicy).get("img-src")).toEqual(["'self'", "data:", API]);
  });

  it("names no other origin when there is no API", () => {
    const policy = contentSecurityPolicy({ scripts: [], styles: [], api: "", admin: true });
    expect(policy).not.toMatch(/https?:/);
  });

  it("keeps a place for hand-written script hashes, empty until phase 3A-4", () => {
    expect(EXTRA_SCRIPT_HASHES).toEqual([]);
  });
});

describe("static headers", () => {
  it("are the full set", () => {
    expect(STATIC_HEADERS).toMatchObject({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect(STATIC_HEADERS["Permissions-Policy"]).toContain("camera=()");
  });
});

describe("admin pages", () => {
  it.each(["/desk", "/desk/sections", "/desk/sections/edit"])("%s is private", (path) => {
    expect(isPrivatePath(path)).toBe(true);
  });

  it.each(["/", "/desktop", "/projects/desk"])("%s is public", (path) => {
    expect(isPrivatePath(path)).toBe(false);
  });
});
