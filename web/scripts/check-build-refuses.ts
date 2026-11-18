// Runs `npm run build` against an API that is failing or down, and fails
// unless each build exits non-zero for that reason. Pages keeps the last good
// build when a build fails, so a failed build is safe. An API that answers with
// nothing published must build, with a placeholder home page and /desk, or the
// owner could never reach /desk to publish. A good build first fills the fetch
// cache, so a build that reused an old answer would pass and be caught.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const GOOD = '{"settings":{},"sections":[{"type":"text","title":"About","items":[]}],"media":{}}';
const EMPTY = '{"settings":{},"sections":[],"media":{}}';

let answer = { status: 200, body: GOOD };
const api = createServer((_, response) => {
  response.writeHead(answer.status, { "Content-Type": "application/json" });
  response.end(answer.body);
});
await new Promise<void>((done) => api.listen(0, "localhost", done));
const origin = `http://localhost:${(api.address() as AddressInfo).port}`;

// Not spawnSync: the API above runs in this process and must keep answering.
function build(apiBase: string): Promise<{ exit: number; output: string }> {
  const env = { ...process.env, API_BASE_URL: apiBase };
  Reflect.deleteProperty(env, "SKIP_SITE_FETCH");
  return new Promise((done) => {
    const child = spawn("npm run build", { env, shell: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => done({ exit: code ?? 1, output }));
  });
}

const wrong: string[] = [];
const good = await build(origin);
console.log(`good site: build exited ${good.exit}`);
if (good.exit !== 0) wrong.push("good site");

answer = { status: 200, body: EMPTY };
const empty = await build(origin);
const home = existsSync("out/index.html") ? readFileSync("out/index.html", "utf8") : "";
const placeholder =
  empty.exit === 0 &&
  home.includes("Site coming soon") &&
  /<meta name="robots" content="noindex/.test(home) &&
  (existsSync("out/desk.html") || existsSync("out/desk/index.html"));
console.log(`nothing published: build exited ${empty.exit}${placeholder ? "" : ", no placeholder or /desk"}`);
if (!placeholder) wrong.push("nothing published");

const cases: [string, () => void, RegExp][] = [
  ["API answers 503", () => (answer = { status: 503, body: "{}" }), /answered 503/],
  ["API unreachable", () => api.close(), /fetch failed|ECONNREFUSED/],
];
for (const [name, arrange, reason] of cases) {
  arrange();
  const { exit, output } = await build(origin);
  const why = reason.test(output);
  console.log(`${name}: build exited ${exit}${why ? "" : ", for another reason"}`);
  if (exit === 0 || !why) wrong.push(name);
}
api.close();

if (wrong.length) {
  console.error(`Build check failed: ${wrong.join(", ")}`);
  process.exit(1);
}
console.log("Builds without a usable site fail; an empty site builds a placeholder.");
