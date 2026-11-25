import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// The access review page, inside admin.spec.ts after the owner has signed in. It
// uses the API's real answer. The browser-test database is the test container's
// superuser, so the page must show its superuser warning here.

const PAGE = "/desk/access";
const API = "http://localhost:8100";
const PRINCIPALS = [
  "owner_sessions",
  "owner_passkeys",
  "database_app_rw",
  "database_migrator",
  "deploy_pipeline",
  "pages_deploy_hook",
  "cloudflare_api_token",
  "cloudflare_access",
  "recovery_key",
];
const read = (name: string) => readFileSync(resolve(__dirname, "../../api", name), "utf8").trim();

const main = (page: Page) => page.locator("main");
const card = (page: Page, id: string) => page.locator(`[data-principal="${id}"]`);

export function accessTests(getPage: () => Page) {
  test.describe("access review", () => {
    test.describe.configure({ mode: "serial" });

    test("is in the navigation and has one card for each principal, with the notes", async () => {
      const page = getPage();
      await page.goto("/desk/sections");
      await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Access", exact: true }).click();
      await expect(page).toHaveURL(/\/desk\/access$/);
      await expect(page.getByRole("heading", { level: 1, name: "Access review" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Access", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("principal")).toHaveCount(PRINCIPALS.length);
      for (const id of PRINCIPALS) {
        await expect(card(page, id).getByRole("heading", { level: 2 })).toBeVisible();
        await expect(card(page, id).getByRole("heading", { level: 3, name: "Can", exact: true })).toBeVisible();
        await expect(card(page, id).getByRole("heading", { level: 3, name: "Cannot", exact: true })).toBeVisible();
        await expect(card(page, id)).toContainText("Credential");
        await expect(card(page, id)).toContainText("Expiry");
        await expect(card(page, id)).toContainText("Last used");
      }
      await expect(main(page)).toContainText("A quarterly review is the plan");
      await expect(main(page)).toContainText("docs/ACCESS.md");
      await expect(main(page)).not.toContainText(/last reviewed/i);
    });

    test("warns plainly that the database connection is a superuser", async () => {
      const page = getPage();
      await page.goto(PAGE);
      const warning = main(page).getByRole("alert").filter({ hasText: "connected to the database as a superuser" });
      await expect(warning).toBeVisible();
      await expect(warning).toContainText("must never be the case in production");
      await expect(card(page, "database_app_rw").getByRole("alert")).toContainText("connected as a superuser");
    });

    test("marks only the principals the app cannot inspect", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(page.getByText("Not checked by the app", { exact: true })).toHaveCount(2);
      for (const id of ["deploy_pipeline", "cloudflare_api_token"]) {
        await expect(card(page, id).getByText("Not checked by the app", { exact: true })).toBeVisible();
        await expect(card(page, id)).toContainText("Not known");
      }
      for (const id of ["owner_sessions", "owner_passkeys", "database_app_rw", "recovery_key"]) {
        await expect(card(page, id).getByText("Not checked by the app", { exact: true })).toHaveCount(0);
      }
      // A secret is shown only as set or not set.
      await expect(card(page, "pages_deploy_hook")).toContainText(/Secret\s*(Set|Not set)/);
    });

    test("lists this session and the passkey, and links to the Security page for revoking", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(card(page, "owner_sessions").getByTestId("sessions")).toContainText("This session");
      await expect(card(page, "owner_passkeys").getByTestId("passkeys").locator("li").first()).toBeVisible();
      const link = card(page, "owner_sessions").getByRole("link", { name: /Sign out everywhere/ });
      await expect(link).toHaveAttribute("href", "/desk/security");
      await expect(card(page, "owner_passkeys").getByRole("link", { name: /Remove a passkey/ })).toHaveAttribute(
        "href",
        "/desk/security",
      );
      await expect(card(page, "deploy_pipeline").getByRole("link")).toHaveCount(0);
      await link.click();
      await expect(page).toHaveURL(/\/desk\/security$/);
      await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
    });

    test("never shows or receives anything secret-looking", async () => {
      const page = getPage();
      await page.goto(PAGE);
      await expect(page.getByTestId("principal")).toHaveCount(PRINCIPALS.length);
      const text = await main(page).innerText();
      expect(text).not.toMatch(/[A-Za-z0-9_+/=-]{32,}/);
      expect(text).not.toMatch(/eyJ|Bearer |-----BEGIN/);
      for (const secret of [read(".e2e-access-token"), read(".e2e-session-token"), "e2e-bootstrap-token"]) {
        expect(text).not.toContain(secret);
      }
      // The answer itself carries no key that names a secret, and no long random value.
      const answer = await page.evaluate(async (base) => {
        const response = await fetch(`${base}/api/v1/admin/access`, { credentials: "include" });
        return (await response.json()) as unknown;
      }, API);
      const walk = (value: unknown, path: string): string[] => {
        if (Array.isArray(value)) return value.flatMap((each, i) => walk(each, `${path}[${i}]`));
        if (value && typeof value === "object") {
          return Object.entries(value).flatMap(([key, each]) => [
            ...(/secret|token|hash|password|private|cookie/i.test(key) ? [`key ${path}.${key}`] : []),
            ...walk(each, `${path}.${key}`),
          ]);
        }
        return typeof value === "string" && /^[A-Za-z0-9_+/=-]{40,}$/.test(value) ? [`value at ${path}`] : [];
      };
      expect(walk(answer, "access")).toEqual([]);
    });

    test("an API failure or an odd answer shows an error, never an empty page", async () => {
      const page = getPage();
      await page.route("**/api/v1/admin/access", (route) => route.fulfill({ status: 500, body: "{}" }));
      await page.goto(PAGE);
      await expect(main(page).getByRole("alert")).toContainText("Something went wrong");
      await expect(page.getByTestId("principal")).toHaveCount(0);
      await page.unroute("**/api/v1/admin/access");

      await page.route("**/api/v1/admin/access", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ principals: [] }) }),
      );
      await page.goto(PAGE);
      await expect(main(page).getByRole("alert")).toContainText("not what this page expected");
      await expect(page.getByTestId("principal")).toHaveCount(0);
      await page.unroute("**/api/v1/admin/access");
    });

    test("fits a phone screen", async () => {
      const page = getPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(PAGE);
      await expect(page.getByTestId("principal")).toHaveCount(PRINCIPALS.length);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 720 });
    });
  });
}
