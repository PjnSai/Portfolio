import { expect, test } from "@playwright/test";

function nonceIn(policy: string | undefined): string {
  return /'nonce-([^']+)'/.exec(policy ?? "")?.[1] ?? "";
}

test("each response carries a strict policy with its own nonce", async ({
  request,
}) => {
  const first = (await request.get("/")).headers()["content-security-policy"];
  const second = (await request.get("/")).headers()["content-security-policy"];

  expect(first).toContain("default-src 'self'");
  expect(first).toContain("frame-ancestors 'none'");
  expect(first).not.toContain("unsafe-inline");
  expect(first).not.toContain("unsafe-eval");
  expect(nonceIn(first)).not.toBe("");
  expect(nonceIn(first)).not.toBe(nonceIn(second));
});

test("the page's own scripts carry the nonce and nothing is blocked", async ({
  page,
}) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      blocked.push(message.text());
    }
  });

  const response = await page.goto("/");
  await page.waitForLoadState("networkidle");
  const nonce = nonceIn(response?.headers()["content-security-policy"]);
  const nonces = await page.evaluate(() =>
    Array.from(document.scripts, (script) => script.nonce),
  );

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(nonces.length).toBeGreaterThan(0);
  expect(new Set(nonces)).toEqual(new Set([nonce]));
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

for (const path of ["/", "/healthz", "/no-such-page"]) {
  test(`${path} carries the other security headers`, async ({ request }) => {
    const headers = (await request.get(path)).headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["content-security-policy"]).toContain("'nonce-");
    expect(headers["x-powered-by"]).toBeUndefined();
  });
}
