import type { Page } from "@playwright/test";
import { API, SITE } from "./contact";

// Helpers for the public CV tests. Turnstile is replaced by a stand-in (see
// form.ts); the API is the real one, with a seeded live CV (api/tests/e2e_server.py).

export type StatusBody = {
  can_view: boolean;
  can_request: boolean;
  instant_download?: boolean;
  updated?: string | null;
};

const CORS = { "Access-Control-Allow-Origin": SITE, Vary: "Origin" };

let counter = 0;

/**
 * Give the page its own client address on every CV route, as Cloudflare would,
 * so the API's limits for one address (ten view links an hour) are not shared
 * by every test.
 */
export async function withCvAddress(page: Page) {
  counter += 1;
  const address = `198.51.100.${((Date.now() + counter * 11) % 250) + 1}`;
  await page.route(`${API}/api/v1/cv/**`, (route) => {
    if (route.request().method() === "GET" && route.request().url().endsWith("/api/v1/cv")) {
      return route.fallback();
    }
    return route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": address },
    });
  });
}

/** Answer GET /api/v1/cv with a chosen status instead of the API's own. */
export async function stubStatus(page: Page, body: StatusBody | { status: number }) {
  await page.route(`${API}/api/v1/cv`, (route) => {
    if ("status" in body) {
      return route.fulfill({ status: body.status, headers: CORS, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify({ updated: "2026-11-20", ...body }),
    });
  });
}

/** Answer a POST to one of the CV routes with a fixed status and body. */
export async function stubPost(
  page: Page,
  path: "link" | "request",
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  await page.route(`${API}/api/v1/cv/${path}`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status,
      headers: { ...CORS, "Access-Control-Expose-Headers": "Retry-After", ...headers },
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/**
 * Turnstile's stand-in that waits: the check passes only when the test says so
 * (window.__passCheck()), so a test can look at the page while it is pending.
 */
const HELD = `(function(){
var n=0,w={},queue=[];
window.__passCheck=function(){queue.splice(0).forEach(function(f){f()})};
window.turnstile={
render:function(c,o){var id="w"+(++n);w[id]=o;return id},
execute:function(id){var o=w[id];queue.push(function(){o.callback("XXXX.DUMMY.TOKEN.XXXX#"+Date.now()+"-"+(++n))})},
reset:function(){},
remove:function(id){delete w[id]}
};
})();`;

export async function stubHeldTurnstile(page: Page) {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: HELD }),
  );
}

/** Scroll the CV block into view so its code is fetched. */
export async function reachCv(page: Page) {
  await page.locator("[data-cv-block]").scrollIntoViewIfNeeded();
}

/** Problems a visitor's console would show, including policy violations. */
export function consoleProblems(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") seen.push(message.text());
  });
  page.on("pageerror", (error) => seen.push(error.message));
  return seen;
}

/**
 * A small, plain PDF of text pages, the same shape as the one the API's
 * browser-test server seeds (no scripts, no fonts embedded).
 */
export function seededPdf(pages = 2, label = "Seeded CV"): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = Array.from({ length: pages }, (_, n) => `${3 + 2 * n} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + 2 * pages;
  for (let n = 0; n < pages; n += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + 2 * n} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    const text = `BT /F1 24 Tf 72 700 Td (${label} page ${n + 1} of ${pages}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A PDF that carries a script, which the API refuses. */
export function scriptedPdf(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
    "latin1",
  );
}
