import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ADMIN_STYLE_HASHES,
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
    expect(policy.get("script-src")).toEqual(
      ["'self'", ...[HASH, ...EXTRA_SCRIPT_HASHES].sort().map((h) => `'${h}'`)],
    );
    expect(policy.get("style-src")).toEqual(["'self'"]);
    expect(directives(adminPolicy).get("style-src")).toEqual(
      ["'self'", ...[HASH, ...ADMIN_STYLE_HASHES].sort().map((h) => `'${h}'`)],
    );
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

  it("lists hand-written script hashes as SHA-256 only (tests/boot-script.test.ts checks the value)", () => {
    expect(EXTRA_SCRIPT_HASHES.length).toBeGreaterThan(0);
    for (const hash of EXTRA_SCRIPT_HASHES) expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
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

describe("colour picker style", () => {
  it("is the one react-colorful adds, allowed on admin pages only", () => {
    const file = createRequire(import.meta.url).resolve("react-colorful");
    const source = readFileSync(file, "utf8");
    const literal = /innerHTML='((?:[^'\\]|\\.)*)'/.exec(source);
    expect(literal).not.toBeNull();
    const css = literal![1].replace(/\\(.)/g, "$1");
    const hash = `sha256-${createHash("sha256").update(css, "utf8").digest("base64")}`;

    expect(ADMIN_STYLE_HASHES).toEqual([hash]);
    expect(adminPolicy).toContain(`'${hash}'`);
    expect(publicPolicy).not.toContain(hash);
  });
});
