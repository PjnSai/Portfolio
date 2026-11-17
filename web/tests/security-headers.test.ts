import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  newNonce,
  securityHeaders,
} from "@/lib/security-headers";
import { proxy } from "@/proxy";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    }),
  );
}

function nonceIn(policy: string): string | undefined {
  return /'nonce-([^']+)'/.exec(policy)?.[1];
}

describe("nonce", () => {
  it("is 128 random bits and never repeats", () => {
    const nonces = new Set(Array.from({ length: 200 }, newNonce));

    expect(nonces.size).toBe(200);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});

describe("Content-Security-Policy", () => {
  const policy = directives(contentSecurityPolicy("abc123"));

  it("lets scripts and styles run only with the nonce", () => {
    expect(policy.get("script-src")).toEqual([
      "'self'",
      "'nonce-abc123'",
      "'strict-dynamic'",
    ]);
    expect(policy.get("style-src")).toEqual(["'self'", "'nonce-abc123'"]);
  });

  it("has no unsafe sources and no wildcards", () => {
    const text = contentSecurityPolicy("abc123");

    expect(text).not.toContain("unsafe-inline");
    expect(text).not.toContain("unsafe-eval");
    expect(text).not.toContain("*");
    expect(text).not.toMatch(/https?:/);
  });

  it("denies by default and blocks framing, plugins and base tags", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("relaxes only for the development server", () => {
    const development = directives(contentSecurityPolicy("abc123", true));

    expect(development.get("script-src")).toContain("'unsafe-eval'");
    expect(development.get("script-src")).toContain("'nonce-abc123'");
    expect(development.get("script-src")).not.toContain("'unsafe-inline'");
  });
});

describe("security headers", () => {
  it("are the full set", () => {
    expect(securityHeaders("abc123")).toMatchObject({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect(securityHeaders("abc123")["Permissions-Policy"]).toContain(
      "camera=()",
    );
  });
});

describe("proxy", () => {
  const paths = ["/", "/healthz", "/_next/static/chunks/app.js", "/missing"];

  it.each(paths)("puts every header on %s", (path) => {
    const response = proxy(new NextRequest(`https://portfolio.test${path}`));
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(nonceIn(policy)).toBeTruthy();
    expect(securityHeaders(nonceIn(policy) ?? "")).toEqual(
      Object.fromEntries(
        Object.keys(securityHeaders("")).map((name) => [
          name,
          response.headers.get(name),
        ]),
      ),
    );
  });

  it("uses a new nonce for each request", () => {
    const nonces = Array.from({ length: 20 }, () =>
      nonceIn(
        proxy(new NextRequest("https://portfolio.test/")).headers.get(
          "content-security-policy",
        ) ?? "",
      ),
    );

    expect(new Set(nonces).size).toBe(20);
  });

  it("hands the same policy to the renderer and ignores a supplied nonce", () => {
    const request = new NextRequest("https://portfolio.test/", {
      headers: {
        "x-nonce": "attacker",
        "content-security-policy": "script-src 'nonce-attacker'",
      },
    });

    const response = proxy(request);
    const policy = response.headers.get("content-security-policy");

    expect(policy).not.toContain("attacker");
    expect(
      response.headers.get("x-middleware-request-content-security-policy"),
    ).toBe(policy);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(
      nonceIn(policy ?? ""),
    );
  });
});
