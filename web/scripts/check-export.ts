// Fails if the build produced anything that needs a server, or leaked a secret.
// Pages Functions, SSR, middleware and route handlers would all run on Workers,
// which the free plan limits; the site must be plain files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRules, measureRules } from "../lib/pages-headers.ts";
import { BOOT_SCRIPT } from "../lib/public/boot-script.ts";
import { EXTRA_SCRIPT_HASHES } from "../lib/security-headers.ts";

const problems: string[] = [];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const required of ["out/index.html", "out/404.html", "out/_headers"]) {
  if (!existsSync(required)) problems.push(`missing ${required}`);
}

// Pages ignores a _headers file past its limits, which would drop every header.
if (existsSync("out/_headers")) {
  problems.push(...measureRules(readFileSync("out/_headers", "utf8")).problems);
}

// Every page carries the boot script exactly as written, and every policy
// allows it by hash; no page has a style attribute (the policy allows none).
const htmlFiles = walk("out").filter((file) => file.endsWith(".html") && !/[\\/]_next[\\/]/.test(file));
for (const file of htmlFiles) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(`<script>${BOOT_SCRIPT}</script>`)) problems.push(`boot script missing or changed: ${file}`);
  if (/<[^>]+\sstyle=/.test(text)) problems.push(`style attribute: ${file}`);
}
if (existsSync("out/_headers")) {
  for (const rule of parseRules(readFileSync("out/_headers", "utf8"))) {
    for (const [name, value] of rule.set) {
      if (name !== "Content-Security-Policy") continue;
      for (const hash of EXTRA_SCRIPT_HASHES) {
        if (!value.includes(`'${hash}'`)) problems.push(`policy for ${rule.path} lacks ${hash}`);
      }
    }
  }
}

// Server output: a standalone server, middleware, or functions for Pages.
for (const path of [".next/standalone", "out/_worker.js", "functions", "out/functions"]) {
  if (existsSync(path)) problems.push(`server output at ${path}`);
}
for (const file of walk(".next/server")) {
  if (/(^|[\\/])(middleware|proxy)\.js$/.test(file)) problems.push(`middleware: ${file}`);
}

// Prefetch files must sit where the client asks for them (flatten-segments.ts).
for (const file of walk("out")) {
  const path = file.replace(/\\/g, "/");
  if (!path.startsWith("out/_next/") && /\/__next\.[^/]*\//.test(path)) {
    problems.push(`nested prefetch file: ${file}`);
  }
}

// Source that needs a server at run time.
const SERVER_ONLY = [
  [/^\s*["']use server["']/m, "server action"],
  [/from\s+["']next\/headers["']/, "cookies() or headers()"],
  [/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/, "dynamic rendering"],
  [/\bconnection\(\)/, "dynamic rendering"],
] as const;
for (const file of walk("app").concat(walk("components"), walk("lib"))) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  if (/[\\/]route\.tsx?$/.test(file)) problems.push(`route handler: ${file}`);
  const source = readFileSync(file, "utf8");
  for (const [pattern, what] of SERVER_ONLY) {
    if (pattern.test(source)) problems.push(`${what}: ${file}`);
  }
}
for (const file of ["middleware.ts", "proxy.ts"]) {
  if (existsSync(file)) problems.push(`middleware: ${file}`);
}

// No secret value from the build environment may end up in a shipped file.
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|HOOK|_KEY$)/;
const secrets = Object.entries(process.env)
  .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
  .map(([name, value]) => [name, value as string]);
for (const file of walk("out")) {
  if (statSync(file).size > 5_000_000) continue;
  const text = readFileSync(file, "latin1");
  for (const [name, value] of secrets) {
    if (text.includes(value)) problems.push(`${name} appears in ${file}`);
  }
}

if (problems.length) {
  console.error(`Static export check failed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Static export check passed.");
