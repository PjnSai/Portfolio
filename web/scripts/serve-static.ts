// Serves the static export the way Cloudflare Pages does: /x is x.html or
// x/index.html, unknown paths get 404.html with status 404, and out/_headers
// decides the headers. Used by the browser tests and the local container.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { headersFor, parseRules } from "../lib/pages-headers.ts";

const ROOT = resolve(process.env.STATIC_ROOT ?? "out");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOSTNAME ?? "0.0.0.0";
const rules = parseRules(readFileSync(join(ROOT, "_headers"), "utf8"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function file(path: string): string | null {
  const full = normalize(join(ROOT, path));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

function find(path: string): string | null {
  if (path.endsWith("/")) return file(`${path}index.html`);
  if (path.split("/").pop() === "_headers") return null;
  return file(`${path}.html`) ?? file(`${path}/index.html`) ?? file(path);
}

createServer((request, response) => {
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  } catch {
    path = "/";
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const found = path.includes("\0") ? null : find(path);
  const served = found ?? join(ROOT, "404.html");
  const headers = headersFor(rules, path);
  headers.set("Content-Type", TYPES[extname(served)] ?? "application/octet-stream");
  response.writeHead(found ? 200 : 404, Object.fromEntries(headers));
  response.end(request.method === "HEAD" ? undefined : readFileSync(served));
}).listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} on http://${HOST}:${PORT}`);
});
