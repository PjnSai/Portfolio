import { describe, expect, it } from "vitest";
import { createClient, UnexpectedAnswer } from "@/lib/admin/api";
import { accessApi, hasSuperuserWarning, type Principal } from "@/lib/admin/access";
import { fakeFetch } from "./fakes";

function principal(over: Record<string, unknown> = {}) {
  return {
    id: "deploy_pipeline",
    name: "Deploy pipeline",
    can: ["Build the images."],
    cannot: ["Read content."],
    credential: "A short-lived pass for each run.",
    expires: null,
    expiry: "Each pass lasts one run.",
    last_used: null,
    checked_by_app: false,
    revocable_here: false,
    revoke: null,
    note: "Not checked by the app.",
    ...over,
  };
}

describe("the access client", () => {
  it("reads from /access with no query", async () => {
    const { calls, fetcher } = fakeFetch([[200, { principals: [principal()] }]]);
    const result = await accessApi(createClient(fetcher)).read();
    expect(new URL(calls[0].url, "http://localhost").pathname).toBe("/api/v1/admin/access");
    expect(new URL(calls[0].url, "http://localhost").search).toBe("");
    expect(result[0].name).toBe("Deploy pipeline");
  });

  it("keeps only the fields it knows, so an extra secret-looking field is never held", async () => {
    const { fetcher } = fakeFetch([
      [
        200,
        {
          principals: [
            principal({ token: "abc", secret: "s", password_hash: "h", session_id: "i" }),
          ],
        },
      ],
    ]);
    const [kept] = await accessApi(createClient(fetcher)).read();
    expect(JSON.stringify(kept)).not.toMatch(/token|secret|hash|session_id|"abc"/);
  });

  it.each([
    ["no principals", {}],
    ["an empty list", { principals: [] }],
    ["a principal without a name", { principals: [principal({ name: undefined })] }],
    ["a can list that is text", { principals: [principal({ can: "everything" })] }],
    ["a checked flag that is text", { principals: [principal({ checked_by_app: "yes" })] }],
  ])("refuses an answer with %s", async (_name, body) => {
    const { fetcher } = fakeFetch([[200, body]]);
    await expect(accessApi(createClient(fetcher)).read()).rejects.toBeInstanceOf(UnexpectedAnswer);
  });

  it("finds a superuser warning on any principal", async () => {
    const warned = {
      principals: [principal(), principal({ id: "database_app_rw", warning: "Superuser." })],
    };
    const { fetcher } = fakeFetch([[200, warned]]);
    const list: Principal[] = await accessApi(createClient(fetcher)).read();
    expect(hasSuperuserWarning(list)).toBe(true);
    expect(hasSuperuserWarning([list[0]])).toBe(false);
  });
});
