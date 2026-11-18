// Runs `npm run build` against an API that is down, failing, or has nothing
// published, and fails unless each of those builds exits non-zero for that
// reason. Pages keeps the last good build when a build fails, so a failed
// build is safe and an empty one is not. A good build first fills the fetch
// cache, so a build that reused an old answer would pass and be caught.
import { spawn } from "node:child_process";
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

const cases: [string, () => void, RegExp][] = [
  ["no published sections", () => (answer = { status: 200, body: EMPTY }), /no published sections/],
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
console.log("Builds without a usable site fail.");
