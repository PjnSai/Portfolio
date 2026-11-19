import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

// The site is static: the policy comes from out/_headers, with the hashes of
// each page's inline scripts instead of a per-request nonce.

function hashesIn(policy: string | undefined): string[] {
  return [...(policy ?? "").matchAll(/'(sha256-[^']+)'/g)].map((m) => m[1]);
}

const sha = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

test("public pages are static: no nonce, the same policy each time, cacheable", async ({
  request,
}) => {
  const first = await request.get("/");
  const second = await request.get("/");
  const policy = first.headers()["content-security-policy"];

  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain("nonce-");
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  expect(second.headers()["content-security-policy"]).toBe(policy);
  expect(first.headers()["cache-control"] ?? "").not.toContain("no-store");
  expect(first.headers()["set-cookie"]).toBeUndefined();
  expect(await first.text()).not.toContain("nonce=");
});

test("every inline script on a page is listed in its policy and nothing is blocked", async ({
  page,
}) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) blocked.push(message.text());
  });

  for (const path of ["/", "/desk/sections"]) {
    const response = await page.goto(path);
    await page.waitForLoadState("networkidle");
    const listed = hashesIn(response?.headers()["content-security-policy"]);
    const inline = await page.evaluate(() =>
      Array.from(document.scripts)
        .filter((script) => !script.src && script.textContent && script.type !== "application/ld+json")
        .map((script) => script.textContent ?? ""),
    );

    expect(inline.length).toBeGreaterThan(0);
    for (const text of inline) expect(listed).toContain(sha(text));
  }
  expect(blocked).toEqual([]);
});

test("the JSON-LD blocks are data: not in the policy, never blocked, and valid", async ({ page }) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) blocked.push(message.text());
  });
  for (const [path, type] of [
    ["/", "Person"],
    ["/projects/task-board", "CreativeWork"],
  ]) {
    const response = await page.goto(path);
    await page.waitForLoadState("networkidle");
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks, path).toHaveLength(1);
    const data = JSON.parse(blocks[0]);
    expect(data["@type"]).toBe(type);
    expect(hashesIn(response?.headers()["content-security-policy"])).not.toContain(sha(blocks[0]));
  }
  expect(blocked).toEqual([]);
});

test("injected inline script does not run", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) =>
        resolve(event.effectiveDirective),
      );
    });
    const element = document.createElement("div");
    element.innerHTML = '<img src="x" onerror="window.injected = true">';
    document.body.append(element);
    const button = document.createElement("button");
    button.setAttribute("onclick", "window.injected = true");
    document.body.append(button);
    button.click();
    return {
      directive: await violation,
      ran: "injected" in window,
    };
  });

  expect(result.ran).toBe(false);
  expect(result.directive).toContain("script-src");
});

for (const path of ["/", "/desk", "/no-such-page"]) {
  test(`${path} carries the other security headers`, async ({ request }) => {
    const headers = (await request.get(path)).headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).not.toContain(", ");
    expect(headers["x-powered-by"]).toBeUndefined();
  });
}

test("an unknown path is a real 404", async ({ request }) => {
  expect((await request.get("/no-such-page")).status()).toBe(404);
});
