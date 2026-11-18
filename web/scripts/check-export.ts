// Fails if the build produced anything that needs a server, or leaked a secret.
// Pages Functions, SSR, middleware and route handlers would all run on Workers,
// which the free plan limits; the site must be plain files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
