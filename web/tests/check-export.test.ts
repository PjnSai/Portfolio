import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BOOT_SCRIPT } from "@/lib/public/boot-script";

const SCRIPT = fileURLToPath(new URL("../scripts/check-export.ts", import.meta.url));
const page = (body: string) => `<!DOCTYPE html><html><head><script>${BOOT_SCRIPT}</script></head><body>${body}</body></html>`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function exportWith(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "check-export-"));
  const all = { "out/index.html": page(""), "out/404.html": page(""), "out/_headers": "", ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    // No build secrets: the leak check compares against the environment.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
  });
}

describe("check:export", () => {
  it("passes a clean export with list pages", () => {
    const run = exportWith({ "out/projects/page/2.html": page("<p>Two</p>") });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fails if a list page has a style attribute", () => {
    const run = exportWith({ "out/projects/page/2.html": page('<p style="color:red">Two</p>') });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/style attribute: out.projects.page.2.html/);
  });

  it("prints home's initial JS and fails a page over 150 kB gzipped", () => {
    const big = randomBytes(160_000).toString("latin1");
    const pass = exportWith({
      "out/index.html": page('<script src="/_next/static/chunks/a.js" async=""></script>'),
      "out/_next/static/chunks/a.js": "console.log(1)",
    });
    expect(pass.status).toBe(0);
    expect(pass.stdout).toMatch(/Home initial JS: 0\.\d kB gzipped of 150 kB/);

    const fail = exportWith({
      "out/projects.html": page('<script src="/_next/static/chunks/b.js" async=""></script>'),
      "out/_next/static/chunks/b.js": big,
    });
    expect(fail.status).toBe(1);
    expect(fail.stderr).toMatch(/initial JS 1\d\d\.\d kB over 150 kB: out.projects\.html/);
  });

  it("does not count the legacy nomodule script", () => {
    const run = exportWith({
      "out/index.html": page('<script src="/_next/static/chunks/c.js" noModule=""></script>'),
      "out/_next/static/chunks/c.js": randomBytes(160_000).toString("latin1"),
    });
    expect(run.status).toBe(0);
  });
});
